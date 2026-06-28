use super::{
    db_modified, lifecycle::lifecycle_status, missing_store_status, readonly_store_paths,
    status_state_is_failure,
};
use crate::protocol::{
    GraphDetectChangesRequest, GraphFactQuerySelector, GraphImpactRequest, GraphNamedQueryRequest,
    GraphProviderStatus, GraphReviewContextRequest, GraphSearchRequest,
};
use crate::query::{GraphIndex, GraphStoreQueryResult};
use crate::store::{GraphStore, StoreError, StorePaths, StoreQueryOutput, StoreSearchOutput};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::SystemTime;

#[derive(Default)]
pub(super) struct SessionCache {
    stores: BTreeMap<PathBuf, CachedStore>,
    #[cfg(test)]
    stats: SessionCacheStats,
}

pub(super) struct SessionChangeDetection<'a> {
    pub(super) stored_hashes: &'a [crate::extraction::SourceFileHash],
    pub(super) current_hashes: &'a [crate::extraction::SourceFileHash],
    pub(super) request: &'a GraphDetectChangesRequest,
}

struct CachedStore {
    db_modified: SystemTime,
    generated_at: Option<String>,
    store: GraphStore,
    status_by_watch_paths: BTreeMap<Vec<String>, GraphProviderStatus>,
    snapshot: Option<StoreQueryOutput>,
    index: Option<GraphIndex>,
}

#[cfg(test)]
#[derive(Default)]
struct SessionCacheStats {
    status_loads: usize,
    snapshot_loads: usize,
    index_builds: usize,
}

impl SessionCache {
    pub(super) fn status_for_repo(
        &mut self,
        repo_root: &str,
        watch_paths: &[String],
    ) -> Result<GraphProviderStatus, StoreError> {
        if let Some(status) = lifecycle_status(repo_root) {
            return Ok(status);
        }
        let paths = readonly_store_paths(repo_root)?;
        if !paths.db_path.is_file() {
            self.stores.remove(&paths.repo_root);
            return Ok(missing_store_status(&paths.repo_root));
        }
        let (status, status_loaded) = {
            let cached = self.cached_store_mut_from_paths(paths)?;
            if let Some(status) = cached.status_by_watch_paths.get(watch_paths) {
                (status.clone(), false)
            } else {
                let status = cached.store.status_for_watch_paths(None, watch_paths)?;
                if status_state_is_failure(&status) {
                    cached.clear_graph_data();
                    cached.status_by_watch_paths.clear();
                }
                cached
                    .status_by_watch_paths
                    .insert(watch_paths.to_vec(), status.clone());
                (status, true)
            }
        };
        self.record_status_load(status_loaded);
        Ok(status)
    }

    pub(super) fn query(
        &mut self,
        repo_root: &str,
        selector: &GraphFactQuerySelector,
    ) -> Result<StoreQueryOutput, StoreError> {
        let (result, snapshot_loaded) = {
            let cached = self.cached_store_mut(repo_root)?;
            let snapshot_loaded = cached.ensure_snapshot()?;
            let Some(snapshot) = cached.snapshot.as_ref() else {
                return Err(StoreError::InvalidSnapshot(
                    "graph store snapshot is missing".to_string(),
                ));
            };
            let result = match crate::query::select_graph_facts(
                &snapshot.nodes,
                &snapshot.edges,
                selector,
            ) {
                GraphStoreQueryResult::Available { nodes, edges } => Ok(StoreQueryOutput {
                    metadata: snapshot.metadata.clone(),
                    nodes,
                    edges,
                    diagnostics: snapshot.diagnostics.clone(),
                }),
                GraphStoreQueryResult::Unsupported { message } => {
                    Err(StoreError::UnsupportedMode(message))
                }
            };
            (result, snapshot_loaded)
        };
        self.record_snapshot_load(snapshot_loaded);
        result
    }

    pub(super) fn search(
        &mut self,
        repo_root: &str,
        request: &GraphSearchRequest,
    ) -> Result<StoreSearchOutput, StoreError> {
        self.cached_store_mut(repo_root)?.store.search(request)
    }

    pub(super) fn named_query(
        &mut self,
        repo_root: &str,
        request: &GraphNamedQueryRequest,
    ) -> Result<crate::query::GraphNamedQueryOutput, StoreError> {
        let (result, snapshot_loaded, index_built) = {
            let cached = self.cached_store_mut(repo_root)?;
            let (loaded, built) = cached.ensure_index()?;
            let (Some(snapshot), Some(index)) = (cached.snapshot.as_ref(), cached.index.as_ref())
            else {
                return Err(StoreError::InvalidSnapshot(
                    "graph store snapshot is missing".to_string(),
                ));
            };
            (
                Ok(crate::query::named_query_with_index(
                    snapshot, index, request,
                )),
                loaded,
                built,
            )
        };
        self.record_graph_loads(snapshot_loaded, index_built);
        result
    }

    pub(super) fn impact(
        &mut self,
        repo_root: &str,
        request: &GraphImpactRequest,
    ) -> Result<crate::query::GraphImpactOutput, StoreError> {
        let (result, snapshot_loaded, index_built) = {
            let cached = self.cached_store_mut(repo_root)?;
            let (loaded, built) = cached.ensure_index()?;
            let (Some(snapshot), Some(index)) = (cached.snapshot.as_ref(), cached.index.as_ref())
            else {
                return Err(StoreError::InvalidSnapshot(
                    "graph store snapshot is missing".to_string(),
                ));
            };
            (
                Ok(crate::query::impact_with_index(snapshot, index, request)),
                loaded,
                built,
            )
        };
        self.record_graph_loads(snapshot_loaded, index_built);
        result
    }

    pub(super) fn review_context(
        &mut self,
        repo_root: &str,
        hashes: crate::query::GraphReviewContextHashes<'_>,
        request: &GraphReviewContextRequest,
    ) -> Result<crate::query::GraphReviewContextOutput, StoreError> {
        let (result, snapshot_loaded, index_built) = {
            let cached = self.cached_store_mut(repo_root)?;
            let (loaded, built) = cached.ensure_index()?;
            let (Some(snapshot), Some(index)) = (cached.snapshot.as_ref(), cached.index.as_ref())
            else {
                return Err(StoreError::InvalidSnapshot(
                    "graph store snapshot is missing".to_string(),
                ));
            };
            (
                Ok(crate::query::review_context_with_index(
                    snapshot, hashes, request, index,
                )),
                loaded,
                built,
            )
        };
        self.record_graph_loads(snapshot_loaded, index_built);
        result
    }

    pub(super) fn detect_changes(
        &mut self,
        repo_root: &str,
        input: SessionChangeDetection<'_>,
    ) -> Result<crate::query::GraphChangesOutput, StoreError> {
        let (result, snapshot_loaded) = {
            let cached = self.cached_store_mut(repo_root)?;
            let snapshot_loaded = cached.ensure_snapshot()?;
            let Some(snapshot) = cached.snapshot.as_ref() else {
                return Err(StoreError::InvalidSnapshot(
                    "graph store snapshot is missing".to_string(),
                ));
            };
            let result = Ok(crate::query::detect_changes(
                snapshot,
                input.stored_hashes,
                input.current_hashes,
                input.request,
            ));
            (result, snapshot_loaded)
        };
        self.record_snapshot_load(snapshot_loaded);
        result
    }

    pub(super) fn file_hashes(
        &mut self,
        repo_root: &str,
    ) -> Result<Vec<crate::extraction::SourceFileHash>, StoreError> {
        self.cached_store_mut(repo_root)?.store.file_hashes()
    }

    fn cached_store_mut(&mut self, repo_root: &str) -> Result<&mut CachedStore, StoreError> {
        let paths = readonly_store_paths(repo_root)?;
        self.cached_store_mut_from_paths(paths)
    }

    fn cached_store_mut_from_paths(
        &mut self,
        paths: StorePaths,
    ) -> Result<&mut CachedStore, StoreError> {
        let db_modified = db_modified(&paths)?;
        let repo_root = paths.repo_root.clone();
        let replace = match self.stores.get(&repo_root) {
            Some(cached) => {
                cached.db_modified != db_modified || !cached.generated_at_is_current()?
            }
            None => true,
        };
        if replace {
            self.stores
                .insert(repo_root.clone(), CachedStore::open(paths, db_modified)?);
        }
        self.stores
            .get_mut(&repo_root)
            .ok_or_else(|| StoreError::InvalidSnapshot("graph store cache is missing".to_string()))
    }

    fn record_graph_loads(&mut self, snapshot_loaded: bool, index_built: bool) {
        self.record_snapshot_load(snapshot_loaded);
        #[cfg(test)]
        {
            if index_built {
                self.stats.index_builds += 1;
            }
        }
        #[cfg(not(test))]
        {
            let _ = (snapshot_loaded, index_built);
        }
    }

    fn record_status_load(&mut self, status_loaded: bool) {
        #[cfg(test)]
        {
            if status_loaded {
                self.stats.status_loads += 1;
            }
        }
        #[cfg(not(test))]
        {
            let _ = status_loaded;
        }
    }

    fn record_snapshot_load(&mut self, snapshot_loaded: bool) {
        #[cfg(test)]
        {
            if snapshot_loaded {
                self.stats.snapshot_loads += 1;
            }
        }
        #[cfg(not(test))]
        {
            let _ = snapshot_loaded;
        }
    }

    #[cfg(test)]
    pub(super) fn status_loads(&self) -> usize {
        self.stats.status_loads
    }

    #[cfg(test)]
    pub(super) fn snapshot_loads(&self) -> usize {
        self.stats.snapshot_loads
    }

    #[cfg(test)]
    pub(super) fn index_builds(&self) -> usize {
        self.stats.index_builds
    }
}

impl CachedStore {
    fn open(paths: StorePaths, db_modified: SystemTime) -> Result<Self, StoreError> {
        let store = GraphStore::open_readonly(paths)?;
        let generated_at = store.snapshot_generated_at()?;
        Ok(Self {
            db_modified,
            generated_at,
            store,
            status_by_watch_paths: BTreeMap::new(),
            snapshot: None,
            index: None,
        })
    }

    fn ensure_snapshot(&mut self) -> Result<bool, StoreError> {
        if self.snapshot.is_some() {
            return Ok(false);
        }
        let snapshot = self.store.query_snapshot()?;
        self.generated_at = Some(snapshot.metadata.generated_at.clone());
        self.snapshot = Some(snapshot);
        self.index = None;
        Ok(true)
    }

    fn ensure_index(&mut self) -> Result<(bool, bool), StoreError> {
        let snapshot_loaded = self.ensure_snapshot()?;
        if self.index.is_some() {
            return Ok((snapshot_loaded, false));
        }
        let Some(snapshot) = self.snapshot.as_ref() else {
            return Err(StoreError::InvalidSnapshot(
                "graph store snapshot is missing".to_string(),
            ));
        };
        self.index = Some(crate::query::graph_index(snapshot));
        Ok((snapshot_loaded, true))
    }

    fn clear_graph_data(&mut self) {
        self.snapshot = None;
        self.index = None;
    }

    fn generated_at_is_current(&self) -> Result<bool, StoreError> {
        Ok(self.store.snapshot_generated_at()? == self.generated_at)
    }
}

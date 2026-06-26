use crate::extraction::{
    normalize_watch_paths, FileFacts, SourceFileHash, EXTRACTION_GENERATED_AT,
};
use crate::protocol::{
    available_status_with_wal_checkpoint, stale_status, AvailableStatusInput,
    GraphExtractionDiagnostic, GraphFactEdge, GraphFactNode, GraphFactQuerySelector,
    GraphFreshness, GraphPipelineSummary, GraphProviderStatus, GraphSearchRequest,
    GraphSnapshotMetadata, GraphWalCheckpointSummary, RepoIdentity,
};
use crate::query::{select_graph_facts, GraphStoreQueryResult};
use crate::search;
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use std::path::Path;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

mod metadata;
mod schema;
mod types;
mod write;

pub use schema::store_user_version;
pub(crate) use types::SnapshotRefreshOptions;
pub use types::{
    FreshnessState, StoreError, StorePaths, StoreQueryOutput, StoreResult, StoreSearchOutput,
    StoreSnapshot,
};

use metadata::{
    collect_rows, current_source_hashes, freshness_age_ms, hash_mismatch_reason,
    missing_metadata_freshness, missing_watch_root_reason, read_optional_json,
    scoped_source_hashes, source_hash_discovery_failed, stale_freshness, stale_metadata_freshness,
    stale_metadata_freshness_with_age,
};
use schema::{configure_sqlite, migrate_or_validate, validate_schema};
#[cfg(test)]
use schema::{require_index, require_table, STORE_INDEX_NAMES};
use write::{
    clear_snapshot_tables, insert_search_update_metadata, validate_snapshot, write_search_index,
    write_snapshot_rows, PreviousSearchFacts, SnapshotIndexes, SnapshotInsertContext,
};

// v1 columns already persist Rust facts: language/kind/signature/qualified_name,
// parent_name/params/return_type/modifiers/is_test/is_exported, plus nodes_fts.
const STORE_SCHEMA_VERSION: u32 = 1;
const COMPAT_SCHEMA_VERSION: &str = "6";
pub const WAL_AUTOCHECKPOINT_PAGES: u32 = 1_000;
pub const DEFAULT_WAL_BUDGET_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug)]
pub struct GraphStore {
    paths: StorePaths,
    connection: Connection,
    search_schema_repaired: bool,
}

impl GraphStore {
    pub fn open(paths: StorePaths) -> StoreResult<Self> {
        if !paths.repo_root.is_dir() {
            return Err(StoreError::RequiredMissing(format!(
                "{} is not a directory",
                display_path(&paths.repo_root)
            )));
        }
        let paths = StorePaths::for_repo_root(paths.repo_root.canonicalize()?);
        std::fs::create_dir_all(&paths.graph_dir)?;
        let connection = Connection::open(&paths.db_path)?;
        configure_sqlite(&connection)?;
        let search_schema_repaired = migrate_or_validate(&connection)?;
        Ok(Self {
            paths,
            connection,
            search_schema_repaired,
        })
    }

    pub fn open_readonly(paths: StorePaths) -> StoreResult<Self> {
        if !paths.repo_root.is_dir() {
            return Err(StoreError::RequiredMissing(format!(
                "{} is not a directory",
                display_path(&paths.repo_root)
            )));
        }
        let paths = StorePaths::for_repo_root(paths.repo_root.canonicalize()?);
        if !paths.db_path.is_file() {
            return Err(StoreError::RequiredMissing(format!(
                "{} does not exist",
                display_path(&paths.db_path)
            )));
        }
        let connection =
            Connection::open_with_flags(&paths.db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        validate_schema(&connection)?;
        Ok(Self {
            paths,
            connection,
            search_schema_repaired: false,
        })
    }

    pub fn paths(&self) -> &StorePaths {
        &self.paths
    }

    pub fn search_schema_repaired(&self) -> bool {
        self.search_schema_repaired
    }

    pub fn validate_schema(&self) -> StoreResult<()> {
        validate_schema(&self.connection)
    }

    pub fn refresh_full_snapshot(&mut self, snapshot: StoreSnapshot) -> StoreResult<()> {
        self.refresh_full_snapshot_with_operation(snapshot, "full")
    }

    pub fn refresh_full_snapshot_with_operation(
        &mut self,
        snapshot: StoreSnapshot,
        operation: &str,
    ) -> StoreResult<()> {
        self.refresh_snapshot_with_operation(snapshot, SnapshotRefreshOptions::full(operation))
    }

    pub(crate) fn refresh_snapshot_with_operation(
        &mut self,
        snapshot: StoreSnapshot,
        options: SnapshotRefreshOptions<'_>,
    ) -> StoreResult<()> {
        validate_snapshot(&snapshot)?;
        let now = now_rfc3339();
        let incremental_search = options.incremental_search();
        let previous = self.previous_search_facts(incremental_search)?;
        let indexes = SnapshotIndexes::from_snapshot(&snapshot);

        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        clear_snapshot_tables(&tx, incremental_search)?;
        let context = SnapshotInsertContext::new(&self.paths.repo_root, &now, options.operation);
        write_snapshot_rows(&tx, &context, &snapshot, &indexes)?;
        let search_update = write_search_index(&tx, &snapshot, &previous, &options)?;
        insert_search_update_metadata(&tx, &search_update)?;
        tx.commit()?;
        self.validate_schema()
    }

    fn previous_search_facts(&self, incremental_search: bool) -> StoreResult<PreviousSearchFacts> {
        if !incremental_search {
            return Ok(PreviousSearchFacts::default());
        }
        Ok(PreviousSearchFacts {
            nodes: self.read_nodes()?,
            edges: self.read_edges()?,
        })
    }

    pub fn record_pipeline_summary(&self, summary: &GraphPipelineSummary) -> StoreResult<()> {
        let summary_json = serde_json::to_string(summary)?;
        self.connection.execute(
            "insert or replace into lattice_store(key, value) values ('last_pipeline_summary_json', ?1)",
            params![summary_json],
        )?;
        self.connection.execute(
            "insert or replace into metadata(key, value) values ('lattice_pipeline_summary_json', ?1)",
            params![serde_json::to_string(summary)?],
        )?;
        Ok(())
    }

    pub fn last_pipeline_summary(&self) -> StoreResult<Option<GraphPipelineSummary>> {
        read_optional_json(
            &self.connection,
            "select value from lattice_store where key = 'last_pipeline_summary_json'",
        )
    }

    pub fn cached_file_facts(&self) -> StoreResult<Vec<FileFacts>> {
        Ok(read_optional_json(
            &self.connection,
            "select value from lattice_store where key = 'file_facts_json'",
        )?
        .unwrap_or_default())
    }

    pub fn file_hashes(&self) -> StoreResult<Vec<SourceFileHash>> {
        self.read_file_hashes()
    }

    pub fn checkpoint_wal_if_over_budget(
        &self,
        budget_bytes: u64,
    ) -> StoreResult<GraphWalCheckpointSummary> {
        let wal_path = self.paths.db_path.with_extension("db-wal");
        let bytes_before = std::fs::metadata(&wal_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let checkpointed = bytes_before > budget_bytes;
        if checkpointed {
            self.connection
                .pragma_update(None, "wal_checkpoint", "TRUNCATE")?;
        }
        let bytes_after = std::fs::metadata(&wal_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        Ok(GraphWalCheckpointSummary {
            wal_path: display_path(&wal_path),
            bytes_before,
            bytes_after,
            budget_bytes,
            checkpointed,
        })
    }

    pub fn status(&self, max_age_ms: Option<u64>) -> StoreResult<GraphProviderStatus> {
        self.status_for_watch_paths(max_age_ms, &[])
    }

    pub fn status_for_watch_paths(
        &self,
        max_age_ms: Option<u64>,
        watch_paths: &[String],
    ) -> StoreResult<GraphProviderStatus> {
        match self.freshness_state_for_watch_paths(max_age_ms, watch_paths)? {
            FreshnessState::Available {
                metadata,
                freshness,
            } => {
                let wal_checkpoint = self
                    .last_pipeline_summary()?
                    .and_then(|summary| summary.wal_checkpoint);
                Ok(available_status_with_wal_checkpoint(AvailableStatusInput {
                    repo: metadata.repo,
                    freshness,
                    db_path: Some(display_path(&self.paths.db_path)),
                    message: Some("graph store snapshot available".to_string()),
                    wal_checkpoint,
                }))
            }
            FreshnessState::Stale {
                metadata,
                freshness,
                reason,
            } => Ok(stale_status(
                metadata
                    .map(|metadata| metadata.repo)
                    .unwrap_or_else(|| repo_identity(&self.paths.repo_root)),
                freshness,
                reason,
            )),
        }
    }

    pub fn freshness_state(&self, max_age_ms: Option<u64>) -> StoreResult<FreshnessState> {
        self.freshness_state_for_watch_paths(max_age_ms, &[])
    }

    pub fn freshness_state_for_watch_paths(
        &self,
        max_age_ms: Option<u64>,
        watch_paths: &[String],
    ) -> StoreResult<FreshnessState> {
        self.validate_schema()?;
        let watch_paths =
            normalize_watch_paths(watch_paths).map_err(StoreError::InvalidSnapshot)?;
        let metadata = self.read_metadata()?;
        let Some(metadata) = metadata else {
            return Ok(missing_metadata_freshness(max_age_ms));
        };

        let stored_hashes = scoped_source_hashes(self.read_file_hashes()?, &watch_paths);
        let age_ms = max_age_ms
            .map(|_| freshness_age_ms(&metadata.generated_at))
            .unwrap_or(0);
        if let Some(reason) = missing_watch_root_reason(&self.paths.repo_root, &watch_paths) {
            return Ok(FreshnessState::Stale {
                metadata: Some(metadata.clone()),
                freshness: stale_freshness(
                    metadata.generated_at.clone(),
                    age_ms,
                    max_age_ms,
                    reason.clone(),
                ),
                reason,
            });
        }

        let current_hashes = current_source_hashes(&self.paths.repo_root, &watch_paths);
        if source_hash_discovery_failed(&current_hashes.diagnostics) {
            return Ok(stale_metadata_freshness(
                metadata,
                max_age_ms,
                "source hash discovery failed",
            ));
        }

        if let Some(reason) = hash_mismatch_reason(&stored_hashes, &current_hashes.file_hashes) {
            return Ok(FreshnessState::Stale {
                metadata: Some(metadata.clone()),
                freshness: stale_freshness(
                    metadata.generated_at.clone(),
                    age_ms,
                    max_age_ms,
                    reason.clone(),
                ),
                reason,
            });
        }
        if let Some(max_age_ms) = max_age_ms {
            if age_ms > max_age_ms {
                let reason = format!("snapshot age {age_ms}ms exceeds maxAgeMs {max_age_ms}");
                return Ok(stale_metadata_freshness_with_age(
                    metadata,
                    age_ms,
                    Some(max_age_ms),
                    reason,
                ));
            }
        }

        let generated_at = metadata.generated_at.clone();
        Ok(FreshnessState::Available {
            metadata,
            freshness: GraphFreshness {
                generated_at,
                age_ms,
                max_age_ms,
                stale: false,
                reason: None,
            },
        })
    }

    pub fn query(&self, selector: &GraphFactQuerySelector) -> StoreResult<StoreQueryOutput> {
        self.validate_schema()?;
        let snapshot = self.query_snapshot()?;
        match select_graph_facts(&snapshot.nodes, &snapshot.edges, selector) {
            GraphStoreQueryResult::Available { nodes, edges } => Ok(StoreQueryOutput {
                metadata: snapshot.metadata,
                nodes,
                edges,
                diagnostics: snapshot.diagnostics,
            }),
            GraphStoreQueryResult::Unsupported { message } => {
                Err(StoreError::UnsupportedMode(message))
            }
        }
    }

    pub fn search(&self, request: &GraphSearchRequest) -> StoreResult<StoreSearchOutput> {
        self.validate_schema()?;
        let Some(metadata) = self.read_metadata()? else {
            return Err(StoreError::InvalidSnapshot(
                "graph store snapshot is missing".to_string(),
            ));
        };
        let search = search::search(&self.connection, request)?;
        Ok(StoreSearchOutput {
            metadata,
            search,
            diagnostics: self.read_diagnostics()?,
        })
    }

    pub fn query_snapshot(&self) -> StoreResult<StoreQueryOutput> {
        self.validate_schema()?;
        let Some(metadata) = self.read_metadata()? else {
            return Err(StoreError::InvalidSnapshot(
                "graph store snapshot is missing".to_string(),
            ));
        };
        Ok(StoreQueryOutput {
            metadata,
            nodes: self.read_nodes()?,
            edges: self.read_edges()?,
            diagnostics: self.read_diagnostics()?,
        })
    }

    fn read_metadata(&self) -> StoreResult<Option<GraphSnapshotMetadata>> {
        read_optional_json(
            &self.connection,
            "select value from metadata where key = 'lattice_snapshot_metadata'",
        )
    }

    fn read_diagnostics(&self) -> StoreResult<Vec<GraphExtractionDiagnostic>> {
        Ok(read_optional_json(
            &self.connection,
            "select value from metadata where key = 'lattice_diagnostics_json'",
        )?
        .unwrap_or_default())
    }

    fn read_file_hashes(&self) -> StoreResult<Vec<SourceFileHash>> {
        let mut statement = self.connection.prepare(
            "select relative_path, absolute_path, language, sha256 from file_hashes order by relative_path",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(SourceFileHash {
                relative_path: row.get(0)?,
                absolute_path: row.get(1)?,
                language: row.get(2)?,
                sha256: row.get(3)?,
            })
        })?;
        collect_rows(rows)
    }

    fn read_nodes(&self) -> StoreResult<Vec<GraphFactNode>> {
        let mut statement = self
            .connection
            .prepare("select id, kind, path, name, extra from nodes order by id")?;
        let rows = statement.query_map([], read_node_row)?;
        collect_rows(rows)
    }

    fn read_edges(&self) -> StoreResult<Vec<GraphFactEdge>> {
        let mut statement = self.connection.prepare(
            "select id, kind, source_qualified, target_qualified, extra from edges order by kind, source_qualified, target_qualified",
        )?;
        let rows = statement.query_map([], read_edge_row)?;
        collect_rows(rows)
    }
}

fn read_node_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GraphFactNode> {
    if let Some(extra) = row.get::<_, Option<String>>(4)? {
        return parse_canonical_row(&extra, 4);
    }
    Ok(GraphFactNode {
        id: row.get(0)?,
        kind: row.get(1)?,
        path: row.get(2)?,
        name: row.get(3)?,
        attributes: None,
    })
}

fn read_edge_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GraphFactEdge> {
    if let Some(extra) = row.get::<_, Option<String>>(4)? {
        return parse_canonical_row(&extra, 4);
    }
    Ok(GraphFactEdge {
        id: row.get(0)?,
        kind: row.get(1)?,
        from: row.get(2)?,
        to: row.get(3)?,
        attributes: None,
    })
}

fn parse_canonical_row<T: serde::de::DeserializeOwned>(
    extra: &str,
    column: usize,
) -> rusqlite::Result<T> {
    serde_json::from_str(extra).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| EXTRACTION_GENERATED_AT.to_string())
}

fn repo_identity(repo_root: &Path) -> RepoIdentity {
    RepoIdentity {
        repo_id: None,
        repo_root: Some(display_path(repo_root)),
        remote_url: None,
        commit_sha: None,
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub fn boundary_name() -> &'static str {
    "SQLite GraphProvider store boundary"
}

pub fn behavior_status() -> &'static str {
    "implemented: SQLite store, freshness metadata, and public GraphProvider SQLite schema"
}

#[cfg(test)]
mod tests;

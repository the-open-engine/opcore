use std::sync::Arc;

use directories::ProjectDirs;

use crate::{
    cache::{FactCache, MemoryFactCache, PersistentFactCache},
    source::git::GitRepository,
};

pub(crate) fn repository_fact_cache(repository: &GitRepository) -> Arc<dyn FactCache> {
    ProjectDirs::from("org", "the-open-engine", "opcore")
        .and_then(|directories| {
            let root = directories
                .cache_dir()
                .join("v1")
                .join(repository.repository_id().hex());
            PersistentFactCache::open(&root, &[repository.root(), repository.common_dir()]).ok()
        })
        .map_or_else(
            || Arc::new(MemoryFactCache::new()) as Arc<dyn FactCache>,
            |cache| Arc::new(cache) as Arc<dyn FactCache>,
        )
}

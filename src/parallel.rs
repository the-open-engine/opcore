use std::sync::OnceLock;

pub(crate) fn worker_pool() -> Option<&'static rayon::ThreadPool> {
    static WORKERS: OnceLock<Option<rayon::ThreadPool>> = OnceLock::new();
    WORKERS
        .get_or_init(|| {
            let workers = std::thread::available_parallelism()
                .map_or(1, usize::from)
                .clamp(1, crate::limits::MAX_WORKERS);
            rayon::ThreadPoolBuilder::new()
                .num_threads(workers)
                .thread_name(|index| format!("opcore-{index}"))
                .build()
                .ok()
        })
        .as_ref()
}

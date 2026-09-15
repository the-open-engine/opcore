use serde::{Deserialize, Serialize};

pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
pub const MAX_FILES: usize = 10_000;
pub const MAX_GIT_METADATA_BYTES: usize =
    MAX_FILES * (crate::path::MAX_REPOSITORY_PATH_BYTES + 128);
pub const MAX_GIT_ERROR_BYTES: usize = 64 * 1024;
pub const MAX_TOTAL_SOURCE_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_AUXILIARY_PATHS: usize = 4_097;
pub const MAX_TOTAL_AUXILIARY_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_DIAGNOSTICS: usize = 10_000;
pub const MAX_ASSESSMENT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_WORKERS: usize = 4;
pub const MAX_CACHE_ENTRY_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_MEMORY_CACHE_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_MEMORY_CACHE_ENTRIES: usize = 50_000;
pub const MAX_DEPENDENCY_FACTS_PER_FILE: usize = 4_096;
pub const MAX_CALLABLE_FINGERPRINTS_PER_FILE: usize = 4_096;
pub const MAX_CALLABLE_FINGERPRINTS_PER_REQUEST: usize = 200_000;
pub const MIN_DEDUP_CALLABLE_TOKENS: usize = 48;
pub const MAX_REGION_FINGERPRINTS_PER_FILE: usize = 4_096;
pub const MAX_REGION_FINGERPRINTS_PER_REQUEST: usize = 200_000;
pub const MAX_DEDUP_TOKEN_COMPARISONS: usize = 4_000_000;
pub const DEDUP_REGION_KGRAM_TOKENS: usize = 32;
pub const DEDUP_REGION_WINNOW_SPAN: usize = 17;
pub const MIN_DEDUP_REGION_TOKENS: usize = DEDUP_REGION_KGRAM_TOKENS + DEDUP_REGION_WINNOW_SPAN - 1;
pub const MAX_INTERFACE_FACTS_PER_FILE: usize = 4_096;
pub const MAX_INTERFACE_SELECTORS: usize = 400_000;
pub const MAX_GRAPH_EDGES: usize = 200_000;
pub const MAX_IMPACT_EDGE_VISITS: usize = 200_000;
pub const MAX_CYCLE_MEMBER_PATHS: usize = 10;
pub const MAX_CYCLE_WITNESS_PATHS: usize = 10;
pub const MAX_OBSERVATION_PATHS: usize = 5;
pub const MAX_SENSE_FINDINGS: usize = 32;
pub const MAX_SENSE_OBSERVATIONS: usize = 4_096;
pub const MAX_SENSE_SAMPLE_PATHS: usize = 1_024;
/// Maximum parser input nesting accepted before calling recursive parser implementations.
pub const MAX_STRUCTURAL_DEPTH: usize = 256;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct RuleLimits {
    pub max_file_lines: u32,
    pub max_line_bytes: u32,
    pub max_function_lines: u32,
    pub max_parameters: u32,
    pub max_nesting: u32,
    pub max_cyclomatic_complexity: u32,
}

impl Default for RuleLimits {
    fn default() -> Self {
        Self {
            max_file_lines: 1_500,
            max_line_bytes: 512,
            max_function_lines: 100,
            max_parameters: 5,
            max_nesting: 4,
            max_cyclomatic_complexity: 10,
        }
    }
}

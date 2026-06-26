export const RUST_SOURCE_HYGIENE_CHECK_ID = "rust.source-hygiene";
export const RUST_FMT_CHECK_ID = "rust.fmt";
export const RUST_CARGO_CHECK_ID = "rust.cargo-check";
export const RUST_CLIPPY_CHECK_ID = "rust.clippy";
export const RUST_RUSTDOC_CHECK_ID = "rust.rustdoc";
export const RUST_IMPORT_GRAPH_CHECK_ID = "rust.import-graph";
export const RUST_DEAD_CODE_CHECK_ID = "rust.dead-code";
export const RUST_UNUSED_DEPS_CHECK_ID = "rust.unused-deps";
export const RUST_FILE_LENGTH_CHECK_ID = "rust.file-length";
export const RUST_FUNCTION_METRICS_CHECK_ID = "rust.function-metrics";

export const rustValidationCheckIds = [
  RUST_SOURCE_HYGIENE_CHECK_ID,
  RUST_FMT_CHECK_ID,
  RUST_CARGO_CHECK_ID,
  RUST_CLIPPY_CHECK_ID,
  RUST_RUSTDOC_CHECK_ID,
  RUST_IMPORT_GRAPH_CHECK_ID,
  RUST_DEAD_CODE_CHECK_ID,
  RUST_UNUSED_DEPS_CHECK_ID,
  RUST_FILE_LENGTH_CHECK_ID,
  RUST_FUNCTION_METRICS_CHECK_ID
] as const;

export type RustValidationCheckId = (typeof rustValidationCheckIds)[number];

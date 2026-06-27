import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { createCargoCheck, createClippyCheck, createDeadCodeCheck, createRustdocCheck, type RustCommandCheckOptions } from "./cargo-check.js";
import { createFileLengthCheck, type RustFileLengthThresholds } from "./file-length-check.js";
import { createFmtCheck } from "./fmt-check.js";
import { createFunctionMetricsCheck, type RustFunctionMetricThresholds } from "./function-metrics-check.js";
import { createGraphSignalsCheck } from "./graph-signals-check.js";
import { createImportGraphCheck } from "./import-graph-check.js";
import { createSourceHygieneCheck } from "./source-hygiene-check.js";
import { createUnusedDepsCheck } from "./unused-deps-check.js";

export {
  RUST_CARGO_CHECK_ID,
  RUST_CLIPPY_CHECK_ID,
  RUST_DEAD_CODE_CHECK_ID,
  RUST_FILE_LENGTH_CHECK_ID,
  RUST_FMT_CHECK_ID,
  RUST_FUNCTION_METRICS_CHECK_ID,
  RUST_GRAPH_SIGNALS_CHECK_ID,
  RUST_IMPORT_GRAPH_CHECK_ID,
  RUST_RUSTDOC_CHECK_ID,
  RUST_SOURCE_HYGIENE_CHECK_ID,
  RUST_UNUSED_DEPS_CHECK_ID,
  rustValidationCheckIds,
  type RustValidationCheckId
} from "./check-ids.js";
export { createFileLengthCheck, type RustFileLengthThresholds } from "./file-length-check.js";
export { createGraphSignalsCheck } from "./graph-signals-check.js";
export { validationRustAdapterName } from "./check-constants.js";
export {
  createMissingToolRetainedChecks,
  retainedRustCompatibilityCheckIds,
  rustRetainedCompatibilityCurrentUsage,
  type RetainedRustCompatibilityCheckId
} from "./retained-compatibility.js";
export { isRustAdapterOwnedPath, isCargoLockPath, isCargoManifestPath, isRustSourcePath } from "./source-files.js";
export { createRustValidationAdapterStatus, probeRustToolchain } from "./toolchain.js";

export interface CreateRustValidationChecksOptions extends RustCommandCheckOptions {
  fileLength?: RustFileLengthThresholds;
  functionMetrics?: RustFunctionMetricThresholds;
}

export function createRustValidationChecks(options: CreateRustValidationChecksOptions = {}): readonly ValidationCheckDefinition[] {
  return [
    createSourceHygieneCheck(),
    createFmtCheck(options),
    createCargoCheck(options),
    createClippyCheck(options),
    createRustdocCheck(options),
    createImportGraphCheck(options),
    createDeadCodeCheck(options),
    createGraphSignalsCheck(),
    createUnusedDepsCheck(options),
    createFileLengthCheck({
      ...options,
      thresholds: options.fileLength
    }),
    createFunctionMetricsCheck({
      ...options,
      thresholds: options.functionMetrics
    })
  ];
}

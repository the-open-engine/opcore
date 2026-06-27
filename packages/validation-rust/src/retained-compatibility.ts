import type { ValidationAdapterDegradedCheckStatus } from "@the-open-engine/opcore-contracts";
import {
  RUST_DEAD_CODE_CHECK_ID,
  RUST_FUNCTION_METRICS_CHECK_ID,
  RUST_IMPORT_GRAPH_CHECK_ID,
  RUST_RUSTDOC_CHECK_ID,
  RUST_UNUSED_DEPS_CHECK_ID
} from "./check-ids.js";

export const retainedRustCompatibilityCheckIds = [
  RUST_RUSTDOC_CHECK_ID,
  RUST_IMPORT_GRAPH_CHECK_ID,
  RUST_DEAD_CODE_CHECK_ID,
  RUST_UNUSED_DEPS_CHECK_ID,
  RUST_FUNCTION_METRICS_CHECK_ID
] as const;

export type RetainedRustCompatibilityCheckId = (typeof retainedRustCompatibilityCheckIds)[number];

export const rustRetainedCompatibilityCurrentUsage = {
  rustdoc: currentUsage({ opcore: false, orchestra: true, covibes: false, gateway: true }),
  importGraph: currentUsage({ opcore: false, orchestra: true, covibes: false, gateway: true }),
  deadCode: currentUsage({ opcore: false, orchestra: true, covibes: false, gateway: true }),
  unusedDeps: currentUsage({ opcore: false, orchestra: true, covibes: false, gateway: true }),
  functionMetrics: currentUsage({ opcore: true, orchestra: true, covibes: false, gateway: true })
} as const;

export function createMissingToolRetainedChecks(missing: ReadonlySet<string>): readonly ValidationAdapterDegradedCheckStatus[] {
  const checks: ValidationAdapterDegradedCheckStatus[] = [];
  if (missing.has("rustdoc")) {
    checks.push(missingToolRetainedCheck({
      checkId: RUST_RUSTDOC_CHECK_ID,
      status: "unsupported_request",
      reason: "required_tool_unavailable",
      requiredTool: "rustdoc",
      message: "rustdoc is unavailable; native rustdoc coverage remains retained by downstream old-tool gates.",
      currentUsage: rustRetainedCompatibilityCurrentUsage.rustdoc
    }));
  }
  if (missing.has("cargo-depgraph")) {
    checks.push(missingToolRetainedCheck({
      checkId: RUST_IMPORT_GRAPH_CHECK_ID,
      status: "skipped",
      reason: "optional_tool_unavailable",
      requiredTool: "cargo-depgraph",
      message: "cargo-depgraph is unavailable; native module reachability still runs, and downstream old-tool gates retain enriched import evidence.",
      currentUsage: rustRetainedCompatibilityCurrentUsage.importGraph
    }));
  }
  if (missing.has("cargo-udeps")) {
    checks.push(missingToolRetainedCheck({
      checkId: RUST_UNUSED_DEPS_CHECK_ID,
      status: "unsupported_request",
      reason: "required_tool_unavailable",
      requiredTool: "cargo-udeps",
      message: "cargo-udeps is unavailable; unused dependency evidence remains retained by downstream old-tool gates.",
      currentUsage: rustRetainedCompatibilityCurrentUsage.unusedDeps
    }));
  }
  if (missing.has("rust-code-analysis-cli")) {
    checks.push(missingToolRetainedCheck({
      checkId: RUST_FUNCTION_METRICS_CHECK_ID,
      status: "unsupported_request",
      reason: "required_tool_unavailable",
      requiredTool: "rust-code-analysis-cli",
      message: "rust-code-analysis-cli is unavailable; function metric evidence remains retained by downstream old-tool gates.",
      currentUsage: rustRetainedCompatibilityCurrentUsage.functionMetrics
    }));
  }
  return checks;
}

function currentUsage(usage: NonNullable<ValidationAdapterDegradedCheckStatus["currentUsage"]>) {
  return usage;
}

function missingToolRetainedCheck(
  args: Pick<
    ValidationAdapterDegradedCheckStatus,
    "checkId" | "status" | "reason" | "message" | "requiredTool" | "currentUsage"
  >
): ValidationAdapterDegradedCheckStatus {
  return {
    ...args,
    retainedCompatibility: true,
    followUpIssue: "#27/#28/#29"
  };
}

import type {
  ValidationAdapterRuntimeStatus,
  ValidationAdapterToolchainStatus
} from "@the-open-engine/lattice-contracts";
import { rustValidationCheckIds } from "./check-ids.js";
import { validationRustAdapterName } from "./check-constants.js";
import { runTool } from "./process.js";
import { createMissingToolRetainedChecks } from "./retained-compatibility.js";

export interface RustValidationToolchainOptions {
  env?: Record<string, string | undefined>;
}

export function createRustValidationAdapterStatus(
  options: RustValidationToolchainOptions = {}
): ValidationAdapterRuntimeStatus {
  const toolchain = probeRustToolchain(options);
  const missing = new Set(toolchain.filter((tool) => !tool.available).map((tool) => tool.tool));
  const degradedChecks = createMissingToolRetainedChecks(missing);
  const requiredMissing = ["cargo", "rustfmt", "clippy"].some((tool) => missing.has(tool));
  return {
    adapter: validationRustAdapterName,
    status: requiredMissing ? "unavailable" : degradedChecks.length > 0 ? "degraded" : "available",
    checkIds: [...rustValidationCheckIds],
    toolchain,
    degradedChecks,
    tempWorkspaceRequired: true
  };
}

export function probeRustToolchain(options: RustValidationToolchainOptions = {}): readonly ValidationAdapterToolchainStatus[] {
  return [
    probeTool("cargo", "cargo", ["--version"], options.env),
    probeTool("rustfmt", "rustfmt", ["--version"], options.env),
    probeTool("clippy", "cargo", ["clippy", "--version"], options.env),
    probeTool("rustdoc", "rustdoc", ["--version"], options.env),
    probeTool("cargo-udeps", "cargo", ["udeps", "--version"], options.env),
    probeTool("cargo-depgraph", "cargo-depgraph", ["--version"], options.env),
    probeTool("rust-code-analysis-cli", "rust-code-analysis-cli", ["--version"], options.env)
  ];
}

export function toolAvailable(tool: string, options: RustValidationToolchainOptions = {}): boolean {
  return probeRustToolchain(options).some((status) => status.tool === tool && status.available);
}

function probeTool(
  tool: string,
  command: string,
  args: readonly string[],
  env: Record<string, string | undefined> | undefined
): ValidationAdapterToolchainStatus {
  const result = runTool(command, args, { env });
  if (result.ok) {
    const version = (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0];
    return {
      tool,
      available: true,
      command: [command, ...args].join(" "),
      ...(version.length > 0 ? { version } : {})
    };
  }
  return {
    tool,
    available: false,
    command: [command, ...args].join(" "),
    failureMessage: result.failureMessage ?? `${tool} unavailable`
  };
}

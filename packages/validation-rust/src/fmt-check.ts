import type { ValidationCheckDefinition } from "@the-open-engine/lattice-validation";
import { RUST_FMT_CHECK_ID } from "./check-ids.js";
import { rustCheckAdapter, rustCheckOwner, supportedRustValidationScopes } from "./check-constants.js";
import { commandInfrastructureFailure, commandUnavailableFailure, singleStderrPolicyFailure } from "./diagnostics.js";
import { materializeRustWorkspace, resolveRepoPath } from "./materialize.js";
import { runTool } from "./process.js";
import { isRustSourcePath, rustInputSet, skippedRustInputResult } from "./source-files.js";

interface RustFmtCheckOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

interface RustFmtCommand {
  name: "cargo" | "rustfmt";
  args: readonly string[];
  primaryPath?: string;
}

export function createFmtCheck(options: { env?: Record<string, string | undefined>; timeoutMs?: number } = {}): ValidationCheckDefinition {
  return {
    id: RUST_FMT_CHECK_ID,
    owner: rustCheckOwner,
    adapter: rustCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedRustValidationScopes,
    run: async (context) => {
      const skipped = skippedRustInputResult(context);
      if (skipped !== undefined) return skipped;
      const materialized = await materializeRustWorkspace(context, { env: options.env });
      try {
        const command = fmtCommand(context.scope.kind, rustInputSet(context).ownedPaths.filter(isRustSourcePath), materialized.root);
        return runFmtCommand(command, materialized.root, options);
      } finally {
        materialized.cleanup();
      }
    }
  };
}

function fmtCommand(scopeKind: string, rustFiles: readonly string[], root: string): RustFmtCommand {
  if (rustFiles.length > 0 && ["files", "changed", "staged"].includes(scopeKind)) {
    return {
      name: "rustfmt",
      args: ["--check", "--edition", "2021", ...rustFiles.map((path) => resolveRepoPath(root, path))],
      primaryPath: rustFiles[0]
    };
  }
  return {
    name: "cargo",
    args: ["fmt", "--check"]
  };
}

function runFmtCommand(command: RustFmtCommand, root: string, options: RustFmtCheckOptions) {
  const result = runTool(command.name, command.args, {
    cwd: root,
    env: options.env,
    timeoutMs: options.timeoutMs,
    allowedExitCodes: [0, 1]
  });
  return (
    commandInfrastructureFailure(result) ??
    commandUnavailableFailure(result, command.name === "cargo" ? "fmt" : "rustfmt") ??
    fmtPolicyFailure(result, command) ?? { diagnostics: [] }
  );
}

function fmtPolicyFailure(result: ReturnType<typeof runTool>, command: RustFmtCommand) {
  if (result.status === 0) return undefined;
  return singleStderrPolicyFailure({
    path: command.primaryPath,
    code: "RUST_FMT_DRIFT",
    stderr: result.stderr || result.stdout,
    fallback: "Rust formatting drift"
  });
}

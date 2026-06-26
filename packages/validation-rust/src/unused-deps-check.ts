import type { ValidationCheckDefinition, ValidationCheckResult } from "@the-open-engine/lattice-validation";
import type { ValidationDiagnostic } from "@the-open-engine/lattice-contracts";
import { RUST_UNUSED_DEPS_CHECK_ID } from "./check-ids.js";
import { rustCheckAdapter, rustCheckOwner, supportedRustValidationScopes } from "./check-constants.js";
import { loadCargoMetadata, resolveCargoPackageScope, type CargoMetadataPackage } from "./cargo-metadata.js";
import {
  commandInfrastructureFailure,
  diagnostic,
  metadataFailureResult,
  requiredToolUnsupportedFailure,
  singleStderrPolicyFailure,
  sortDiagnostics
} from "./diagnostics.js";
import { materializeRustWorkspace } from "./materialize.js";
import { runTool } from "./process.js";
import { skippedRustInputResult } from "./source-files.js";
import { toolAvailable } from "./toolchain.js";

export function createUnusedDepsCheck(options: { env?: Record<string, string | undefined>; timeoutMs?: number } = {}): ValidationCheckDefinition {
  return {
    id: RUST_UNUSED_DEPS_CHECK_ID,
    owner: rustCheckOwner,
    adapter: rustCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedRustValidationScopes,
    run: async (context) => {
      const skipped = skippedRustInputResult(context);
      if (skipped !== undefined) return skipped;
      if (!toolAvailable("cargo-udeps", { env: options.env })) {
        return {
          status: "unsupported_request",
          diagnostics: [],
          failureMessage: "cargo-udeps is unavailable"
        };
      }
      const materialized = await materializeRustWorkspace(context, { env: options.env });
      try {
        const metadata = loadCargoMetadata(materialized.root, options);
        if (!metadata.ok) return metadataFailureResult(metadata);
        const packageScope = resolveCargoPackageScope(metadata.metadata, context.scope);
        if (!packageScope.ok) return metadataFailureResult(packageScope);
        const result = runTool("cargo", unusedDepsArgs(packageScope.member), {
          cwd: materialized.root,
          env: options.env,
          timeoutMs: options.timeoutMs,
          allowedExitCodes: [0, 1, 101]
        });
        const infrastructureFailure = commandInfrastructureFailure(result);
        if (infrastructureFailure !== undefined) return infrastructureFailure;
        const unsupportedFailure = requiredToolUnsupportedFailure(result, "udeps") ?? requiredToolUnsupportedFailure(result, "cargo-udeps");
        if (unsupportedFailure !== undefined) return unsupportedFailure;
        if (result.status !== 0) {
          const diagnostics = parseUnusedDependencyDiagnostics(result.stderr || result.stdout, packageScope.member);
          if (diagnostics.length > 0) return { diagnostics };
          const toolchainFailure = cargoUdepsToolchainFailure(result);
          if (toolchainFailure !== undefined) return toolchainFailure;
          return singleStderrPolicyFailure({
            path: packageScope.member?.manifestPath ?? "Cargo.toml",
            code: "RUST_UNUSED_DEPS",
            stderr: result.stderr || result.stdout,
            fallback: "Unused Rust dependencies found"
          });
        }
        return { diagnostics: [] };
      } finally {
        materialized.cleanup();
      }
    }
  };
}

function unusedDepsArgs(member: CargoMetadataPackage | undefined): readonly string[] {
  if (member === undefined) return ["udeps", "--workspace", "--all-targets", "--all-features"];
  return ["udeps", "-p", member.name, "--all-targets", "--all-features"];
}

function cargoUdepsToolchainFailure(result: ReturnType<typeof runTool>): ValidationCheckResult | undefined {
  const output = [result.stderr, result.stdout, result.failureMessage].filter(Boolean).join("\n");
  if (!isNightlyRustToolchainFailure(output)) return undefined;
  return {
    status: "unsupported_request",
    diagnostics: [],
    failureMessage: output.trim() || "cargo-udeps requires a nightly Rust toolchain"
  };
}

function isNightlyRustToolchainFailure(output: string): boolean {
  return [
    /option\s+[`'"]?Z[`'"]?\s+is only accepted on the nightly compiler/i,
    /consider switching to a nightly toolchain/i,
    /nightly option(?:s)? were parsed/i
  ].some((pattern) => pattern.test(output));
}

function parseUnusedDependencyDiagnostics(output: string, member: CargoMetadataPackage | undefined): readonly ValidationDiagnostic[] {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const backtick = /^`([^`]+)`/.exec(trimmed);
    if (backtick?.[1] !== undefined) names.add(backtick[1]);
    const labeled = /unused dependenc(?:y|ies):\s*([A-Za-z0-9_.-]+)/i.exec(trimmed);
    if (labeled?.[1] !== undefined) names.add(labeled[1]);
  }
  return sortDiagnostics(
    [...names].map((name) =>
      diagnostic({
        category: "policy",
        path: member?.manifestPath ?? "Cargo.toml",
        code: "RUST_UNUSED_DEPENDENCY",
        message: `Rust dependency is unused: ${name}.`
      })
    )
  );
}

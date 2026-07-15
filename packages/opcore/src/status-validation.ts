import type {
  OpcoreRepoStatePayload,
  OpcoreValidationPolicySummary,
  PythonProjectContext,
  ValidationAdapterRuntimeStatus
} from "@the-open-engine/opcore-contracts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readOpcoreRepoConfig } from "./repo-validation-config.js";
import { relevantDegradedToolchainsForCoverage } from "./scan-presentation.js";
import type { createDefaultValidationStatusPayload } from "./validation-composition.js";

export function validationSummary(
  validationStatus: ReturnType<typeof createDefaultValidationStatusPayload>,
  coverage: OpcoreRepoStatePayload["coverage"],
  policy: OpcoreValidationPolicySummary,
  pythonProjectContexts: readonly PythonProjectContext[] = []
): OpcoreRepoStatePayload["validation"] {
  const adapters = validationStatus.adapterRegistry.adapters ?? [];
  const degraded = adapters.flatMap((adapter) => degradedToolchains(adapter));
  return {
    ready: validationStatus.ready,
    checkCount: validationStatus.adapterRegistry.checkIds.length,
    policy,
    pythonProjectContexts,
    adapters: adapters.map((adapter) => ({
      adapter: adapter.adapter,
      status: adapter.status,
      checkCount: adapter.checkIds.length,
      degradedChecks: (adapter.degradedChecks ?? []).map((check) => check.checkId),
      missingTools: (adapter.toolchain ?? []).filter((tool) => !tool.available).map((tool) => tool.tool)
    })),
    degradedToolchains: relevantDegradedToolchainsForCoverage(coverage, degraded)
  };
}

export function validationPolicySummary(
  repoRoot: string,
  configuredChecks: readonly string[]
): OpcoreValidationPolicySummary {
  const configFileExists = existsSync(join(repoRoot, ".opcore", "config"));
  const config = readOpcoreRepoConfig(repoRoot);
  return {
    path: ".opcore/config",
    state: configFileExists ? "loaded" : "missing",
    adapters: [...(config.validation.adapters ?? [])],
    packs: [...config.validation.checks.packs],
    disabledChecks: [...config.validation.checks.disabled],
    defaultChecks: [...config.validation.checks.defaults],
    configuredChecks: [...configuredChecks]
  };
}

function degradedToolchains(
  adapter: ValidationAdapterRuntimeStatus
): OpcoreRepoStatePayload["validation"]["degradedToolchains"] {
  return (adapter.toolchain ?? [])
    .filter((tool) => !tool.available)
    .map((tool) => ({
      adapter: adapter.adapter,
      tool: tool.tool,
      ...(tool.failureMessage ? { failureMessage: tool.failureMessage } : {})
    }));
}

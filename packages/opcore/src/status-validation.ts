import type {
  OpcoreRepoStatePayload,
  OpcoreValidationPolicySummary,
  PythonProjectContext,
  ValidationAdapterRuntimeStatus
} from "@the-open-engine/opcore-contracts";
import {
  PYTHON_RELEVANT_TESTS_CHECK_ID,
  PYTHON_RUFF_FORMAT_CHECK_ID,
  PYTHON_RUFF_LINT_CHECK_ID,
  PYTHON_SYNTAX_CHECK_ID,
  PYTHON_TYPES_CHECK_ID
} from "@the-open-engine/opcore-validation-python";
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
  const degraded = adapters.flatMap((adapter) => degradedToolchains(adapter, policy.configuredChecks));
  return {
    ready: validationStatus.ready,
    checkCount: validationStatus.adapterRegistry.checkIds.length,
    policy,
    pythonProjectContexts,
    adapters: adapters.map((adapter) => {
      const degradedAdapterTools = degradedToolchains(adapter, policy.configuredChecks);
      return {
        adapter: adapter.adapter,
        status: adapter.status,
        checkCount: adapter.checkIds.length,
        degradedChecks: (adapter.degradedChecks ?? []).map((check) => check.checkId),
        missingTools: [...new Set(degradedAdapterTools.map((tool) => tool.tool))]
      };
    }),
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
  adapter: ValidationAdapterRuntimeStatus,
  activeCheckIds: readonly string[]
): OpcoreRepoStatePayload["validation"]["degradedToolchains"] {
  const activePythonTools = pythonToolsForActiveChecks(activeCheckIds);
  return (adapter.toolchain ?? [])
    .filter((tool) => !tool.available)
    .filter((tool) => adapter.adapter !== "python" || activePythonTools.has(tool.tool))
    .map((tool) => ({
      adapter: adapter.adapter,
      tool: tool.tool,
      ...(tool.failureMessage ? { failureMessage: tool.failureMessage } : {})
    }));
}

function pythonToolsForActiveChecks(activeCheckIds: readonly string[]): ReadonlySet<string> {
  const active = new Set(activeCheckIds);
  const tools = new Set<string>();
  if (active.has(PYTHON_SYNTAX_CHECK_ID)) tools.add("python");
  if (active.has(PYTHON_TYPES_CHECK_ID)) {
    tools.add("python");
    tools.add("mypy");
    tools.add("pyright");
  }
  if (active.has(PYTHON_RUFF_LINT_CHECK_ID) || active.has(PYTHON_RUFF_FORMAT_CHECK_ID)) {
    tools.add("ruff");
  }
  if (active.has(PYTHON_RELEVANT_TESTS_CHECK_ID)) {
    tools.add("python");
    tools.add("pytest");
  }
  return tools;
}

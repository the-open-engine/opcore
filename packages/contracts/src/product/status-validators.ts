import { validateRequiredObject } from "../shared/validators-02.js";
import { includesString } from "../shared/primitives.js";
import { validateProviderStatus } from "../graph/provider-validators.js";
import { graphProviderModes, graphProviderStatusStates } from "../graph/vocabulary-01.js";
import { validateNonEmptyString, validateNonNegativeInteger, validateStringArray } from "../shared/validators-01.js";
import { validateArray, validateBoolean, validateObject, validateOptional } from "../shared/validators-02.js";
import { validatePythonProjectContexts } from "../validation/python-project-validators-01.js";
import { validationAdapterRuntimeStates } from "../validation/status-contracts.js";
import { validateOpcoreCoverageCounts } from "./metrics-validators-05.js";
import type { OpcoreRepoStatePayload, OpcoreValidationPolicySummary } from "./status-contracts.js";

function validateOpcoreRepoStatePayload(payload: OpcoreRepoStatePayload): OpcoreRepoStatePayload {
  validateObject(payload, "Opcore repo state payload");
  if (payload.schemaVersion !== 1) {
    throw new Error("Opcore repo state payload schemaVersion must be 1");
  }
  validateOpcoreRepo(payload.repo);
  validateOpcoreCoverage(payload.coverage);
  validateOpcoreGraph(payload.graph);
  validateOpcoreValidation(payload.validation);
  validateOpcoreActivation(payload.activation);
  validateStringArray(payload.warnings, "Opcore repo state warnings", { allowEmpty: true });
  validateStringArray(payload.blockers, "Opcore repo state blockers", { allowEmpty: true });
  validateStringArray(payload.nextActions, "Opcore repo state nextActions", { allowEmpty: false });
  return payload;
}

export { validateOpcoreRepoStatePayload };

function validateOpcoreRepo(repo: OpcoreRepoStatePayload["repo"]): void {
  validateObject(repo, "Opcore repo state repo");
  validateNonEmptyString(repo.root, "Opcore repo state repo root");
  validateNonEmptyString(repo.requestedPath, "Opcore repo state requested path");
  validateObject(repo.git, "Opcore repo state git payload");
  validateBoolean(repo.git.available, "Opcore repo state git available");
  validateOptional(repo.git.branch, (branch) => validateNonEmptyString(branch, "Opcore repo state git branch"));
  for (const [key, value] of Object.entries(repo.git)) {
    if (key === "available" || key === "branch" || key === "clean") continue;
    validateNonNegativeInteger(value, `Opcore repo state git ${key}`);
  }
  validateOptional(repo.git.clean, (clean) => validateBoolean(clean, "Opcore repo state git clean"));
}

export { validateOpcoreRepo };

function validateOpcoreCoverage(coverage: OpcoreRepoStatePayload["coverage"]): void {
  validateObject(coverage, "Opcore repo state coverage");
  validateNonNegativeInteger(coverage.totalFiles, "Opcore repo state coverage totalFiles");
  validateArray(coverage.languages, "Opcore repo state coverage languages");
  for (const language of coverage.languages) validateOpcoreLanguageCoverage(language);
  validateOpcoreCoverageCounts(coverage.graph, "graph");
  validateOpcoreCoverageCounts(coverage.validation, "validation");
  validateNonNegativeInteger(coverage.validation.retainedFiles, "Opcore repo state validation retainedFiles");
  validateObject(coverage.unsupported, "Opcore repo state unsupported coverage");
  validateNonNegativeInteger(coverage.unsupported.totalFiles, "Opcore repo state unsupported totalFiles");
  validateArray(coverage.unsupported.stacks, "Opcore repo state unsupported stacks");
  for (const stack of coverage.unsupported.stacks) validateOpcoreUnsupportedStack(stack);
}

export { validateOpcoreCoverage };

function validateOpcoreLanguageCoverage(language: OpcoreRepoStatePayload["coverage"]["languages"][number]): void {
  validateNonEmptyString(language.language, "Opcore repo state language");
  validateNonNegativeInteger(language.files, "Opcore repo state language files");
  validateBoolean(language.graphSupported, "Opcore repo state language graphSupported");
  validateBoolean(language.validationSupported, "Opcore repo state language validationSupported");
}

export { validateOpcoreLanguageCoverage };

function validateOpcoreUnsupportedStack(
  stack: OpcoreRepoStatePayload["coverage"]["unsupported"]["stacks"][number],
): void {
  validateNonEmptyString(stack.extension, "Opcore repo state unsupported extension");
  validateNonEmptyString(stack.language, "Opcore repo state unsupported language");
  validateNonNegativeInteger(stack.count, "Opcore repo state unsupported count");
  validateStringArray(stack.examples, "Opcore repo state unsupported examples", { allowEmpty: true });
}

export { validateOpcoreUnsupportedStack };

function validateOpcoreGraph(graph: OpcoreRepoStatePayload["graph"]): void {
  validateObject(graph, "Opcore repo state graph");
  if (!includesString(graphProviderStatusStates, graph.state)) {
    throw new Error(`Unknown Opcore repo state graph state: ${String(graph.state)}`);
  }
  if (!includesString(graphProviderModes, graph.mode)) {
    throw new Error(`Unknown Opcore repo state graph mode: ${String(graph.mode)}`);
  }
  validateNonEmptyString(graph.provider, "Opcore repo state graph provider");
  validateNonEmptyString(graph.action, "Opcore repo state graph action");
  validateOptional(graph.message, (message) => validateNonEmptyString(message, "Opcore repo state graph message"));
  const graphStatus = validateProviderStatus(graph.status);
  if (graphStatus.state !== graph.state || graphStatus.mode !== graph.mode || graphStatus.provider !== graph.provider) {
    throw new Error("Opcore repo state graph summary must match provider status");
  }
}

export { validateOpcoreGraph };

function validateOpcoreValidation(validation: OpcoreRepoStatePayload["validation"]): void {
  validateObject(validation, "Opcore repo state validation");
  validateBoolean(validation.ready, "Opcore repo state validation ready");
  validateNonNegativeInteger(validation.checkCount, "Opcore repo state validation checkCount");
  validateOpcoreValidationPolicySummary(validation.policy, "Opcore repo state validation policy");
  validateArray(validation.adapters, "Opcore repo state validation adapters");
  for (const adapter of validation.adapters) validateOpcoreAdapter(adapter);
  validateArray(validation.degradedToolchains, "Opcore repo state validation degradedToolchains");
  for (const tool of validation.degradedToolchains) validateOpcoreDegradedTool(tool);
  validateOptional(validation.pythonProjectContexts, validatePythonProjectContexts);
}

export { validateOpcoreValidation };

function validateOpcoreAdapter(adapter: OpcoreRepoStatePayload["validation"]["adapters"][number]): void {
  validateNonEmptyString(adapter.adapter, "Opcore repo state validation adapter");
  if (!includesString(validationAdapterRuntimeStates, adapter.status)) {
    throw new Error(`Unknown Opcore validation adapter status: ${String(adapter.status)}`);
  }
  validateNonNegativeInteger(adapter.checkCount, "Opcore repo state validation adapter checkCount");
  validateStringArray(adapter.degradedChecks, "Opcore repo state validation degradedChecks", { allowEmpty: true });
  validateStringArray(adapter.missingTools, "Opcore repo state validation missingTools", { allowEmpty: true });
}

export { validateOpcoreAdapter };

function validateOpcoreDegradedTool(tool: OpcoreRepoStatePayload["validation"]["degradedToolchains"][number]): void {
  validateNonEmptyString(tool.adapter, "Opcore repo state validation degraded adapter");
  validateNonEmptyString(tool.tool, "Opcore repo state validation degraded tool");
  validateOptional(tool.failureMessage, (message) =>
    validateNonEmptyString(message, "Opcore repo state validation degraded failureMessage"),
  );
}

export { validateOpcoreDegradedTool };

function validateOpcoreActivation(activation: OpcoreRepoStatePayload["activation"]): void {
  validateObject(activation, "Opcore repo state activation");
  validateBoolean(activation.ready, "Opcore repo state activation ready");
  if (!includesString(["ready", "degraded", "blocked"] as const, activation.level)) {
    throw new Error(`Unknown Opcore activation level: ${String(activation.level)}`);
  }
  validateNonEmptyString(activation.summary, "Opcore repo state activation summary");
  validateObject(activation.asp, "Opcore repo state ASP status");
  if (!includesString(["enrolled", "not_enrolled"] as const, activation.asp.state)) {
    throw new Error(`Unknown Opcore ASP state: ${String(activation.asp.state)}`);
  }
  validateStringArray(activation.asp.paths, "Opcore repo state ASP paths", { allowEmpty: true });
}

export { validateOpcoreActivation };

function validateOpcoreValidationPolicySummary(
  summary: OpcoreValidationPolicySummary,
  label: string,
): OpcoreValidationPolicySummary {
  validateRequiredObject(summary, `${label} is required`);
  if (summary.path !== ".opcore/config") {
    throw new Error(`${label} path must be .opcore/config`);
  }
  if (!includesString(["missing", "loaded"] as const, summary.state)) {
    throw new Error(`Unknown ${label} state: ${String(summary.state)}`);
  }
  validateStringArray(summary.adapters, `${label} adapters`, {
    allowEmpty: true,
  });
  validateStringArray(summary.packs, `${label} packs`, { allowEmpty: true });
  validateStringArray(summary.disabledChecks, `${label} disabledChecks`, {
    allowEmpty: true,
  });
  validateStringArray(summary.defaultChecks, `${label} defaultChecks`, {
    allowEmpty: true,
  });
  validateStringArray(summary.configuredChecks, `${label} configuredChecks`, {
    allowEmpty: true,
  });
  return summary;
}

export { validateOpcoreValidationPolicySummary };

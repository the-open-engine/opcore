import type {
  OpcoreInitScanSummary,
  OpcoreInitSettings,
  OpcoreRepoStatePayload,
  ValidationResult
} from "@the-open-engine/opcore-contracts";
import {
  createLanguageSetting,
  type LanguageSettingContext
} from "./init-language-settings.js";
import {
  hasPythonEnvironmentSignals,
  pythonEnvironmentFromContexts
} from "./init-python-settings.js";
import { failedValidationCheckIds } from "./scan-presentation.js";
import { scanValidationDiagnosticTotal } from "./scan-validation-preview.js";

const rustActiveValidationKinds = new Set([".rs", ".inc", "Cargo.toml"]);

export function createInitScanSummary(
  repoState: OpcoreRepoStatePayload,
  validationResult: ValidationResult
): OpcoreInitScanSummary {
  return {
    totalFiles: repoState.coverage.totalFiles,
    graphSupportedFiles: repoState.coverage.graph.supportedFiles,
    validationSupportedFiles: repoState.coverage.validation.supportedFiles,
    validationRetainedFiles: repoState.coverage.validation.retainedFiles,
    unsupportedFiles: repoState.coverage.unsupported.totalFiles,
    languages: repoState.coverage.languages,
    unsupportedStacks: repoState.coverage.unsupported.stacks,
    degradedRustTools: repoState.validation.degradedToolchains,
    diagnosticCount: scanValidationDiagnosticTotal(validationResult),
    validationStatus: validationResult.status,
    failedChecks: failedValidationCheckIds(validationResult),
    graphState: repoState.graph.state,
    activationLevel: repoState.activation.level
  };
}

export function createInitSettings(repoState: OpcoreRepoStatePayload): OpcoreInitSettings {
  const contexts = repoState.validation.pythonProjectContexts;
  const pythonProject = pythonEnvironmentFromContexts(
    contexts === undefined ? [] : contexts
  );
  const context: LanguageSettingContext = {
    unsupportedLanguages: new Set(repoState.coverage.unsupported.stacks.map((stack) => stack.language)),
    degradedRustTools: degradedTools(repoState, "rust"),
    degradedPythonTools: degradedTools(repoState, "python"),
    rustHasActiveValidationInput: repoState.coverage.validation.extensions.some((entry) =>
      rustActiveValidationKinds.has(entry.extension)
    ),
    retainedFiles: repoState.coverage.validation.retainedFiles,
    pythonProject
  };
  return {
    languages: repoState.coverage.languages.map((language) => createLanguageSetting(language, context)),
    ...(hasPythonEnvironmentSignals(pythonProject) ? { python: pythonProject } : {})
  };
}

function degradedTools(repoState: OpcoreRepoStatePayload, adapter: "rust" | "python"): string[] {
  return repoState.validation.degradedToolchains
    .filter((tool) => tool.adapter === adapter)
    .map((tool) => tool.tool);
}

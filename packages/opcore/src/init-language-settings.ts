import type {
  OpcoreInitLanguageSetting,
  OpcoreInitPythonEnvironment,
  OpcoreRepoStatePayload
} from "@the-open-engine/opcore-contracts";

export interface LanguageSettingContext {
  unsupportedLanguages: ReadonlySet<string>;
  degradedRustTools: readonly string[];
  degradedPythonTools: readonly string[];
  rustHasActiveValidationInput: boolean;
  retainedFiles: number;
  pythonProject: OpcoreInitPythonEnvironment;
}

export function createLanguageSetting(
  language: OpcoreRepoStatePayload["coverage"]["languages"][number],
  context: LanguageSettingContext
): OpcoreInitLanguageSetting {
  const validation = languageValidationState(language, context);
  return {
    language: language.language,
    files: language.files,
    state: validation,
    graph: language.graphSupported ? "supported" : "unsupported",
    validation,
    checks: checksForLanguage(language.language, validation),
    notes: languageNotes(language.language, validation, context)
  };
}

function languageValidationState(
  language: OpcoreRepoStatePayload["coverage"]["languages"][number],
  context: LanguageSettingContext
): OpcoreInitLanguageSetting["validation"] {
  const rustRetainedOnly =
    language.language === "Rust" &&
    !context.rustHasActiveValidationInput &&
    context.retainedFiles > 0;
  if (context.unsupportedLanguages.has(language.language) && !language.validationSupported) return "unsupported";
  if (rustRetainedOnly) return "retained";
  if (
    language.validationSupported &&
    degradedValidationTools(language.language, context).length > 0
  ) {
    return "degraded";
  }
  return language.validationSupported ? "supported" : "unsupported";
}

function degradedValidationTools(
  language: string,
  context: LanguageSettingContext
): readonly string[] {
  if (language === "Rust") return context.degradedRustTools;
  if (language === "Python") return context.degradedPythonTools;
  return [];
}

function checksForLanguage(language: string, validation: OpcoreInitLanguageSetting["validation"]): string[] {
  if (validation === "unsupported" || validation === "retained") return [];
  if (language === "TypeScript" || language === "JavaScript") {
    return [
      "typescript.syntax", "typescript.types", "typescript.import-graph", "typescript.dead-code",
      "typescript.function-metrics", "typescript.relevant-tests", "typescript.file-length"
    ];
  }
  if (language === "Rust") {
    return [
      "rust.source-hygiene", "rust.fmt", "rust.cargo-check", "rust.clippy", "rust.rustdoc",
      "rust.import-graph", "rust.dead-code", "rust.unused-deps", "rust.file-length", "rust.function-metrics"
    ];
  }
  if (language === "Python") {
    return [
      "python.syntax", "python.source-hygiene", "python.types", "python.import-graph",
      "python.dead-code", "python.relevant-tests", "python.pytest"
    ];
  }
  return [];
}

function languageNotes(
  language: string,
  validation: OpcoreInitLanguageSetting["validation"],
  context: LanguageSettingContext
): string[] {
  if (validation === "unsupported") return ["Unsupported stack counted without fabricated checks."];
  if (validation === "retained") return ["Retained for compatibility; no active checks configured."];
  const degradedTools = language === "Python" ? context.degradedPythonTools : context.degradedRustTools;
  const notes = validation === "degraded"
    ? [`${language} validation tools degraded: ${degradedTools.join(", ")}.`]
    : [];
  if (language === "Python") notes.push(...context.pythonProject.notes);
  return notes;
}

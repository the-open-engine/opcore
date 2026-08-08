const validationDiagnosticCategories = [
  "syntax",
  "types",
  "lint",
  "test",
  "graph",
  "policy",
  "provider",
  "infrastructure",
  "edit_safety",
] as const;

export { validationDiagnosticCategories };

type ValidationDiagnosticCategory = (typeof validationDiagnosticCategories)[number];

export type { ValidationDiagnosticCategory };

const validationResultStatuses = [
  "passed",
  "policy_failure",
  "infrastructure_failure",
  "provider_failure",
  "unsupported_request",
  "invalid_payload",
  "skipped",
  "refused",
] as const;

export { validationResultStatuses };

type ValidationResultStatus = (typeof validationResultStatuses)[number];

export type { ValidationResultStatus };

const validationFailureCategories = [
  "policy_failure",
  "infrastructure_failure",
  "provider_failure",
  "unsupported_request",
  "invalid_payload",
  "skipped",
] as const;

export { validationFailureCategories };

type ValidationFailureCategory = (typeof validationFailureCategories)[number];

export type { ValidationFailureCategory };

const validationReportModes = ["all", "introduced"] as const;

export { validationReportModes };

type ValidationReportMode = (typeof validationReportModes)[number];

export type { ValidationReportMode };

const validationCheckRunStatuses = [
  "passed",
  "policy_failure",
  "infrastructure_failure",
  "provider_failure",
  "unsupported_request",
  "skipped",
] as const;

export { validationCheckRunStatuses };

type ValidationCheckRunStatus = (typeof validationCheckRunStatuses)[number];

export type { ValidationCheckRunStatus };

const validationCheckOutcomes = [
  "passed",
  "findings",
  "tool_unavailable",
  "invalid_config",
  "timeout",
  "unsupported_target",
  "tool_failure",
] as const;

export { validationCheckOutcomes };

type ValidationCheckOutcome = (typeof validationCheckOutcomes)[number];

export type { ValidationCheckOutcome };

const pythonValidationCapabilityRunStatuses = [...validationCheckOutcomes] as const;

export { pythonValidationCapabilityRunStatuses };

type PythonValidationCapabilityRunStatus = (typeof pythonValidationCapabilityRunStatuses)[number];

export type { PythonValidationCapabilityRunStatus };

const pythonValidationAuthorities = ["mypy", "pyright"] as const;

export { pythonValidationAuthorities };

type PythonValidationAuthority = (typeof pythonValidationAuthorities)[number];

export type { PythonValidationAuthority };

import { validationCheckOutcomes } from "./vocabulary-01.js";

const pythonValidationAuthoritySources = ["explicit", "project_config"] as const;

export { pythonValidationAuthoritySources };

type PythonValidationAuthoritySource = (typeof pythonValidationAuthoritySources)[number];

export type { PythonValidationAuthoritySource };

const pythonValidationCapabilityTerminationKinds = ["exited", "timeout", "signal", "spawn_error"] as const;

export { pythonValidationCapabilityTerminationKinds };

type PythonValidationCapabilityTerminationKind = (typeof pythonValidationCapabilityTerminationKinds)[number];

export type { PythonValidationCapabilityTerminationKind };

const pythonValidationCapabilities = ["types", "ruff_lint", "ruff_format", "pytest"] as const;

export { pythonValidationCapabilities };

type PythonValidationCapability = (typeof pythonValidationCapabilities)[number];

export type { PythonValidationCapability };

const pythonValidationCapabilityStates = [...validationCheckOutcomes, "not_applicable", "disabled"] as const;

export { pythonValidationCapabilityStates };

type PythonValidationCapabilityState = (typeof pythonValidationCapabilityStates)[number];

export type { PythonValidationCapabilityState };

const pythonValidationCapabilityTerminations = ["exited", "timeout", "signal", "spawn_error", "overflow"] as const;

export { pythonValidationCapabilityTerminations };

type PythonValidationCapabilityTermination = (typeof pythonValidationCapabilityTerminations)[number];

export type { PythonValidationCapabilityTermination };

const validationSkippedCheckReasons = [
  "graph_unavailable",
  "unsupported_scope",
  "not_requested",
  "no_files",
  "provider_failure",
] as const;

export { validationSkippedCheckReasons };

type ValidationSkippedCheckReason = (typeof validationSkippedCheckReasons)[number];

export type { ValidationSkippedCheckReason };

const validationCheckIdPattern = "^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$" as const;

export { validationCheckIdPattern };

const validationCheckIdRegex = new RegExp(validationCheckIdPattern);

export { validationCheckIdRegex };

const latencyStableIdRegex = /^[a-z][a-z0-9_-]*$/;

export { latencyStableIdRegex };

const latencyTelemetryCommandTokenRegex = /^(?=.*[A-Za-z0-9])[-@A-Za-z0-9._,:=]+$/;

export { latencyTelemetryCommandTokenRegex };

const PYTHON_PROJECT_CONTEXT_SCHEMA_ID = "opcore.python.project-context.v1" as const;

export { PYTHON_PROJECT_CONTEXT_SCHEMA_ID };

const PYTHON_VALIDATION_CAPABILITY_RUN_SCHEMA_ID = "opcore.python.validation-capability-run" as const;

export { PYTHON_VALIDATION_CAPABILITY_RUN_SCHEMA_ID };

const pythonProjectContextOutcomes = ["resolved", "degraded", "unsupported", "ambiguous"] as const;

export { pythonProjectContextOutcomes };

type PythonProjectContextOutcome = (typeof pythonProjectContextOutcomes)[number];

export type { PythonProjectContextOutcome };

const pythonProjectContextReasonCodes = [
  "missing_config",
  "invalid_config",
  "conflicting_managers",
  "conflicting_targets",
  "interpreter_unavailable",
  "tool_unavailable",
  "probe_timeout",
  "probe_signal",
  "probe_spawn_failure",
  "probe_exit_failure",
  "malformed_probe_output",
  "unsupported_target",
  "unsupported_platform",
  "path_refused",
  "symlink_refused",
  "incompatible_interpreter",
  "ambiguous_path",
] as const;

export { pythonProjectContextReasonCodes };

type PythonProjectContextReasonCode = (typeof pythonProjectContextReasonCodes)[number];

export type { PythonProjectContextReasonCode };

const pythonProjectManagerKinds = ["pip", "uv", "poetry", "pdm", "pipenv"] as const;

export { pythonProjectManagerKinds };

type PythonProjectManagerKind = (typeof pythonProjectManagerKinds)[number];

export type { PythonProjectManagerKind };

const pythonProjectLayoutKinds = ["flat", "src", "namespace", "stub", "package"] as const;

export { pythonProjectLayoutKinds };

type PythonProjectLayoutKind = (typeof pythonProjectLayoutKinds)[number];

export type { PythonProjectLayoutKind };

const pythonProjectExecutableSources = [
  "explicit_override",
  "active_environment",
  "project_local_environment",
  "manager_environment",
  "path",
] as const;

export { pythonProjectExecutableSources };

type PythonProjectExecutableSource = (typeof pythonProjectExecutableSources)[number];

export type { PythonProjectExecutableSource };

const pythonProjectToolKinds = ["mypy", "pyright", "ruff", "pytest", "build"] as const;

export { pythonProjectToolKinds };

type PythonProjectToolKind = (typeof pythonProjectToolKinds)[number];

export type { PythonProjectToolKind };

interface PythonProjectContextReason {
  code: PythonProjectContextReasonCode;
  message: string;
  path?: string;
  tool?: string;
}

export type { PythonProjectContextReason };

interface PythonProjectFileEvidence {
  path: string;
  role: "boundary" | "config" | "lock" | "requirements" | "build" | "layout";
}

export type { PythonProjectFileEvidence };

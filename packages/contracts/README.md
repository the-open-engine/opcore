# @the-open-engine/opcore-contracts

Public TypeScript contracts and JSON schema for Opcore package and CLI surfaces.

## Latency Telemetry

`CommandLatencyRecord` is the source-safe JSONL record for `.opcore/telemetry.jsonl`. Records carry command identity, bounded repo shape, status, exit code, and `CommandTiming`; they must not include source content, secrets, repo roots, requested paths, or file paths beyond existing bounded coverage examples. `bin` is the normalized public bin name, and `canonicalCommand` is a sanitized command identity, not raw argv or file operands. The telemetry artifact is ring-buffer rotated at 500 records or 1 MiB.

## Context Docs

`requiredContextDocPolicy` is the shared `require-context-doc` policy for agent guidance filenames, required locations, and minimum content length.

## Python Capability Evidence

`PythonValidationCapabilityRun` (`opcore.python.validation-capability-run`, version 1) is the portable, source-free receipt for one Python capability attempt in one canonical project. Tool executable locations use `repo:`, `project:`, `path:`, or `external:` locators so host and materialization roots never enter receipts. An `invalid_config` run has no authority when conflicting evidence prevents selection; after selection it may carry unexecuted static-config evidence or exited tool evidence. `ValidationResult.pythonCapabilityRuns` retains separate project/context/after-state/authority runs through runner events, introduced mode, scan previews, and ASP evidence mapping.

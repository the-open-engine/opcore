# @the-open-engine/opcore-validation-rust

Opcore Rust validation adapter package for Cargo, lint, import, dead-code, and metric checks.

Cargo and native-tool checks share one environment-keyed temporary workspace per validation file-view state. The
validation runner disposes the workspace after every normal, fail-fast, streaming, or failed run.

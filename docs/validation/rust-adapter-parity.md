# Rust Validation Evidence

`@the-open-engine/opcore-validation-rust` owns Rust provider assessment checks for source hygiene, formatting,
Cargo compilation, clippy, rustdoc, import structure, dead code, graph signals, unused dependencies, file length,
and function metrics.

Cargo-backed checks materialize one isolated after-state workspace per validation file view. Missing optional tools
produce typed degraded or unsupported outcomes with `requiredTool`; they never become silent passes. Graph-backed
checks consume `ValidationGraphProviderClient` facts through public contracts only.

Opcore validates Rust changes through `npm run opcore:self-check`, targeted `opcore check` scopes, and the normal
Rust/CI gates. No external development toolchain is part of this repository's validation path.

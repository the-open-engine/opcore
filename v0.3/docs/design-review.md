# Initial Design Review

Three independent reviews were required before implementation.

## Reviewers

- ASP/conformance/security review.
- Rust storage/performance/worktree review.
- Node/Rust/Python tooling and product-scope review.

## Accepted Findings

1. Keep only content-view, file-fact, and repository storage identities. Do not duplicate Git's Merkle tree or enumerate the workspace for file-local checks.
2. Specify exact committed/staged/changed/explicit/hypothetical Git semantics, preserve path bytes, refuse unsafe symlinks/unmerged index state, and detect capture races.
3. Persist only self-validating parse/metric facts. Keep context/evaluation memoization process-local.
4. Remove project-native execution from the MVP because temp materialization and timeouts are not isolation from hostile configs, plugins, build scripts, proc macros, descendants, filesystem, environment, or network.
5. Define closed, executable language envelopes and versioned metric semantics.
6. Correct ASP advertised scopes, fully declare the check capability, add strict request/callback validation, and define lifecycle/cancellation terminal behavior.
7. Accept only canonical ASP requests and pin ChangeSet canonical JSON independently from file-fact identities.
8. Do not invent ASP certificate or signing semantics. Produce an installed-binary checksum and render its absolute manifest at installation time.
9. Keep deduplication out of Verify; it belongs in the later Sense/graph boundary.
10. Specify concrete resource bounds and separate warm-provider, cold-CLI, and workspace performance claims.

## Deliberately Deferred

- Public graph/inspect and edit capabilities.
- Native ESLint, rustdoc/clippy, Python environment provisioning/runtime tests, and Go tool execution until each has an explicit backend and enforceable isolation. Python-native selects an existing project environment for static type checking but never creates, updates, or executes the application through it.
- Graph-backed deduplication and structural similarity analysis.
- ASP-branded certificate, certification, registry, trust, or authority mechanics.

## Subsequent Native Slices

The first native experiment added one fixed Rust backend behind explicit selection. The next bounded slice adds locked npm plus project-local TypeScript checking and host Pyright/mypy checking. Each is a distinct ASP provider process and manifest with its own applicability, environment, diagnostic parser, and fixed command set; there is still no generic plugin runner.

Repository trials exposed several useful corrections without widening the backend set. Selected roots are now source focuses with the nearest Node/Python project context or repository context plus a focused Cargo package, provider-aware path capture filters irrelevant assets before bounds, and callers can request either `introduced` or `all` while seeing per-provider elapsed time. Python-native deterministically binds an existing project `.venv` (or an explicit interpreter), passes every selected path to the checker, and treats unresolved imports under only an ambient interpreter as incomplete coverage rather than project defects. Node-native instead follows the configured project exactly: the union of `tsc --listFiles` output is its semantic universe, while unconfigured JavaScript/TypeScript is counted and left to fast syntax/hygiene, just as Cargo ignores `.rs` files outside declared targets. Native evidence also binds the Cargo/rustc, npm/Node/tsc, and checker/Python launchers it actually used. Rust retains a fixed repository-wide Cargo build-input envelope because real code uses workspace/path dependencies and sibling `include_*` resources, while unrelated media and opaque data stay out. Protobuf receives only the lean no-toolchain value available at this layer: pinned bounded syntax and hygiene, with deeper semantics reported unsupported. Large diagnostic sets are summarized by file, rule, and unique location in human output while machine JSON stays exact.

The private harness can select any provider subset and project exact non-overlapping focuses into provider-specific contexts. It materializes provider-private copies and sweeps inherited process groups, but those are execution-hygiene measures rather than containment. Native tools, build scripts, proc macros, compiler dependencies, and mypy plugins retain whatever host access the OS permits. Native results therefore declare advisory execution assurance and remain appropriate only for trusted repositories until an external host supplies enforceable filesystem, network, secret, descendant, CPU, and memory isolation.

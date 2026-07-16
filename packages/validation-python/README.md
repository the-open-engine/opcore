# @the-open-engine/opcore-validation-python

Internal Opcore validation adapter package for the gated Python language-support workstream. Public Python enablement remains blocked on installed-artifact receipts and maintainer approval.

This package owns the canonical, read-only `opcore.python.project-context.v1` resolver. It resolves each `.py`/`.pyi` target to its nearest project boundary, layout/source roots, static manager/build/tool configuration, declared runtime, and exact interpreter/tool provenance. It never installs or synchronizes dependencies, creates environments, executes project imports/setup/package code, writes workspace files, or keeps a persistent cache.

Consumers must inject a workspace view with read/list/exists/realpath operations. Missing realpath evidence is an ambiguous context, not an assumed non-symlink. Validation uses `ValidationFileView` after-state adapters so written and deleted config/source overlays share one identity; ASP uses host workspace callbacks only. Node status and installed-artifact surfaces use the read-only Node adapter. TOML decisions consume the parsed `smol-toml` AST, static build metadata is retained, and build availability is probed independently. All consumers reuse the resolver result instead of scanning project/config/environment filenames independently.

Python import grammar and repo-module resolution belong exclusively to Rust graph-core. This package exposes only the structural `PythonImportAnalyzer` injection contract. Import-dependent checks enumerate every visible `.py`/`.pyi` after-state file through `ValidationFileView`, invoke the required analyzer once per file view, and derive target/transitive source closure from its directed edges. Missing, failed, or malformed analysis fails as infrastructure failure; validation never parses Python imports or treats unavailable analysis as an empty graph.

Precedence is nearest project, explicit per-tool override, compatible active environment, project-local `.venv`/`venv`/`env`, safe installed manager evidence, then PATH. Conflicting same-root manager or target evidence is ambiguous. Missing tools and probe timeout/signal/spawn/exit/malformed-output failures remain typed and visible; unresolved required contexts cannot produce a clean Python check.

Run `npm run python:resolver-matrix -- --json` for checked fixture evidence covering real POSIX execution and explicitly simulated POSIX/Windows layouts.

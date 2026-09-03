# Changelog

## 0.2.2

Fixes validation for workspaces rooted below the Git worktree root.

- Resolves the Git prefix so object reads and diff listings use worktree-root-relative paths while the workspace keeps its own relative view.
- Scopes changed, staged, tree, tracked, and untracked listings to the selected workspace, so sibling packages no longer leak into a nested run.
- Nested runs previously ended in `infrastructure_failure` with no checks executed; they now run the full changed-file gate.
- Reported and fixed by Sigurd Høystad (@saasom) in #298.

## 0.2.1

macOS stability hotfix for Rust validation.

- Materializes one Rust workspace per validation file-view state and materialization environment instead of a fresh recursive copy per check.
- Shares that staged, tree, or hypothetical after-state across the selected Rust checks, and retains separate snapshots when Git or tool environments differ.
- Disposes run-scoped workspaces on normal, fail-fast, streaming, and failed exits.
- Removes the create/delete event storm that drove `fseventsd` memory growth on large repositories and concurrent agent runs.

## 0.2.0

Lighter default robustness loop on large repositories, plus validation correctness work.

- Bounds product scan validation output to summaries, counts, failed check IDs, and diagnostic samples.
- Makes validation file views lazy so path-specific checks skip enumerating every visible file.
- Sends committed clone-analysis inputs as path references, reserving content-bearing overlays for changed or hypothetical files.
- Replaces Python grammar heuristics with exact-interpreter `compile()` validation over `.py`/`.pyi` after-state content, including structured ranges and interpreter provenance.
- Adds native validation-policy parity and tightens the package guardrails around it.

The broader large-monorepo memory program stays open: graph build/query working sets, inspect/edit language-service isolation, bounded history and sidecar payloads, and the regression harness are tracked separately.

## 0.1.0

Initial public release.

- `opcore`: read-only scan, changed-file validation gate (`opcore check`), approval-gated setup (`opcore init`), metric deltas (`opcore measure`), and a local demo loop (`opcore try`).
- Hybrid runtime: a Rust graph core owns extraction, persistence, and queries; TypeScript owns contracts, the CLI, and validation adapters.
- Coverage: deep TypeScript/JavaScript, useful Rust, and experimental Python; other stacks are counted.
- Native graph artifacts for `darwin-arm64`, `darwin-x64`, and `linux-x64`; Windows is unsupported.
- Ships public packages for the CLI, contracts, graph, edit, and validation adapters; fixtures stay internal.

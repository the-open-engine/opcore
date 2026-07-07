# Runtime And CLI Architecture

Status: Accepted
Date: 2026-06-04
Decision: hybrid

## Context

The internal Opcore implementation line is the release line for graph, edit, validation, and the standalone ASP Core check provider facade behind Opcore. The bootstrap repository is TypeScript/npm, but the final runtime must not be chosen by scaffold inertia. The graph provider needs fast source extraction, persistent graph facts, SQLite/WAL indexing, watch daemons, and hot query paths. The edit and validation tracks need TypeScript compiler APIs, ts-morph-compatible orchestration, ESLint-style checks, JSON CLI output, npm packaging, and ACE/Zeroshot integration. The ASP provider facade needs a small stdio JSON-RPC process over host-owned workspace callbacks and Opcore validation checks.

## Decision

Opcore's internal Opcore implementation line uses a hybrid runtime:

- Rust graph core owns graph extraction, indexing, persistence, watch refresh, and hot graph queries.
- TypeScript contracts own public schemas, command input/output shapes, router metadata, adapter request/result envelopes, validation request/response contracts, and generated API types.
- TypeScript CLI router owns public `opcore` product and advanced command dispatch and composes package-owned graph, edit, check, and validate adapters.
- TypeScript edit owns edit planning, patch/tree application, symbol-aware orchestration, and whole-plan validation.
- TypeScript validation owns check policy, validation manifests, hypothetical validation, failure policy, and human/JSON reporting.
- TypeScript validation-rust owns Rust-specific Cargo, rustfmt, clippy, rustdoc, import/dead-code, unused dependency, and function-metric check adapters.
- TypeScript validation-typescript owns TypeScript-specific rules and compiler-backed adapters.
- TypeScript validation-clone owns duplicate-code validation adapter wiring over the injected graph-core clone subcommand, without a graph-provider requirement or SAST/security claim.
- TypeScript asp-provider owns the standalone ASP Core `check/evaluate` provider-process facade and provisional install manifest.
- TypeScript npm facade, ACE descriptors, and ASP provider install manifest own install metadata, runtime discovery inputs, wrapper generation, and release integration.

The ownership invariant is: do not collapse graph, edit, and policy ownership into one muddled abstraction.

## Options Compared

| Option | Outcome | Reason |
|---|---|---|
| TS-only | Rejected | Simpler npm distribution, but graph performance, indexing, watch behavior, SQLite/WAL control, and hot query latency would depend on the wrong runtime boundary. |
| Rust-first | Rejected | Strong graph/runtime performance, but it would fight TypeScript compiler APIs, ESLint-style rule authoring, npm-first install, JSON CLI ergonomics, and ACE hook integration. |
| Hybrid | Accepted | Keeps the graph core in Rust where performance and persistence matter, while TypeScript owns contracts, CLI routing, edit, validation, npm facades, and ACE descriptors. |

## CLI Router

`opcore` is the public product facade for scan/status/check/init/measure/try and the single installed advanced router for package-owned graph, inspect, edit, check, validate, status, and doctor command groups. Scan, status, check, and measure are read-only against the target repo; try writes only generated local sample repos; init is approval-gated setup. Direct old-tool entrypoint execution is unsupported as Opcore release behavior, and current external wrappers remain dev validation helpers only.

| Command | Owner | Responsibility |
|---|---|---|
| `opcore graph` | graph provider | Build, update, watch, status, query, and lifecycle graph facts. |
| `opcore inspect` | CLI/router plus graph provider | Read-only graph-backed symbols, definition, references, signatures, implementations, and search inspection. |
| `opcore edit` | edit | Plan, validate, and apply cohesive edits. |
| `opcore check` | validation | Run mechanical checks and graph-aware checks. |
| `opcore validate` | validation | Validate proposed or hypothetical edits against policy and manifests. |
| `opcore status` | runtime | Report runtime, wrapper, graph, and validation readiness. |
| `opcore doctor` | runtime | Diagnose install, native artifact, wrapper, and ACE/Zeroshot integration problems. |
| `opcore` | runtime | Run zero-command source-read-only scan, print coverage before findings, and write `.opcore/report.json`, `.opcore/history.jsonl`, plus bounded `.opcore/telemetry.jsonl` capped at 500 records or 1 MiB. |
| `opcore status` | runtime | Report read-only repo activation, graph readiness, coverage, degraded toolchains, ASP enrollment hints, and next commands. |
| `opcore check` | validation | Run the universal agent validation gate over changed, staged, or explicit files. |
| `opcore install` | runtime | Run a read-only scan first, print coverage before findings, present the default setup wizard, then write scoped config/guidance, Opcore agent skills, Claude Code and Codex write-gate wiring, managed `.opcore/` ignore state, active pre-commit hook when safe, and undo metadata only when approved. |
| `opcore init` | runtime | Compatibility setup path with conservative explicit approval semantics over the same scan-first setup engine. |
| `opcore measure` | runtime | Read `.opcore/report.json` and `.opcore/history.jsonl` and return read-only metric deltas. |
| `opcore try` | runtime | Generate local TS, Rust, mixed, and unsupported-file sample repos, run the launch loop, and publish nothing. |

Canonical `opcore graph`, `opcore edit`, `opcore check`, and `opcore validate` commands dispatch directly to public adapters owned by `packages/graph`, `packages/edit`, and `packages/validation`. Top-level `opcore inspect symbols|definition|references|signature|implementations|search` is CLI-owned read-only routing backed by public GraphProvider query/search APIs; `opcore inspect references <file> <symbol> --line <n> [--column <n>]` adds #72 inspect-owned TypeScript/JavaScript language-service resolution for CIX refs parity. `opcore inspect signature <file> <symbol> --line <n> [--column <n>]` and `opcore inspect signature <node-id>` add #101 inspect-owned TypeScript/JavaScript language-service signature parity for functions, methods, constructors, classes, interfaces, type aliases, overloads, imported/aliased symbols, path aliases, TS/TSX, JS, and JSX after fresh GraphProvider evidence is available. `opcore inspect implementations <file> <symbol> --line <n> [--column <n>]` and node-id targets add #102 read-only implementation evidence for TypeScript/TSX class implements, class extends, and interface extends relationships over fresh graph facts plus language-service materialization. Unimplemented graph inspect routes are not advertised as release behavior. `opcore edit` implements `exact`, `multi`, `search-replace`, `patch`, `tree`, `rename`, `move`, `signature`, `check`, and `apply` over edit-core, edit-owned patch/tree APIs, and graph-backed symbol planning. `opcore edit patch` accepts unified diffs and Codex `apply_patch` documents; unified `--3way` is explicitly de-scoped for this release and returns a typed refusal instead of attempting dirty-file merges. Symbol routes consume GraphProvider contract status/query/search evidence plus edit-owned TypeScript/JavaScript language-service materialization, then emit normal validation-required edit plans; apply/check refuses graph freshness changes before validation or writes. Search-replace must reject duplicate matches unless `replaceAll` is true. `opcore check` implements `files`, `staged`, `changed`, `tree`, `all`, and `manifest`; tree checks read committed Git tree content from `--tree <ref>` and scope files from `--changed-from <ref>`. `opcore validate` implements request-file validation, `hypothetical`, `pre-write`, and `manifest`. Runtime-owned `opcore status` and `opcore doctor` include typed validation status payloads but do not own validation checks. `opcore status` emits a stable `repoState` payload and must remain read-only: no graph build/update/watch, validation check execution, package install, ASP setup, ACE setup, current-tool wrapper execution, or source writes. `opcore` scan and `opcore check` must avoid source edits, hooks, setup, ASP setup, ACE setup, old-tool wrapper execution, sibling checkouts, and package installs; scan may write only `.opcore/report.json`, `.opcore/history.jsonl`, and bounded `.opcore/telemetry.jsonl` capped at 500 records or 1 MiB. `opcore install` is the recommended setup writer in the public product facade; it runs the same read-only scan without report/history writes, emits scan/settings/interaction/timing in `opcoreInit`, prompts in an interactive Git repo to choose repo or global write-gate scope when neither scope nor `--json`/`--yes` is supplied, keeps JSON and non-TTY no-flag runs plan-only, and approved mode is additive/idempotent. Repo scope appends `.opcore/` to `.gitignore` only in Git repos that do not already ignore it, skips `.gitignore` in non-Git repos, writes `.opcore/config`, agent guidance, Opcore agent skill files, `.opcore/hooks/opcore-agent-gate.mjs`, active `.git/hooks/pre-commit` when safe, and merges Claude Code `.claude/settings.json` plus Codex `.codex/hooks.json`; undo uses repo `.opcore/init-undo.json` through `opcore uninstall`. Global scope writes `~/.opcore/hooks/opcore-agent-gate.mjs`, user-level skill files, merges `~/.claude/settings.json` and `~/.codex/hooks.json`, and records undo in `~/.opcore/init-undo.json`. `opcore init` remains a compatibility setup route with explicit `--approve` semantics. The adapter maps harness write/edit payloads to validation overlays, calls `opcore validate pre-write --request-file <json> --timeout-ms 30000 --json`, exits 2 for non-ok receipts and validation command failures, and fail-opens only for adapter parse/mapping errors. Claude Code PreToolUse blocks matching Edit/MultiEdit/Write calls through exit 2. Codex PreToolUse is wired as the strongest current guardrail for supported edit aliases, but Codex hook trust and interception scope remain harness behavior, so public copy must not claim broader enforcement. The separate fail-closed pre-commit hook script remains opt-in through `--fail-closed-hook`. The managed `.opcore/` ignore covers `.opcore/telemetry.jsonl`. No package may expose old-tool public bins, old `cix` aliases, or old-tool package identities as Opcore release surface.

#58 adds `opcore validate pre-write --request-file <validation-request.json> --timeout-ms 30000 --json` for hook integration. The route is validation-owned, file-based, fail-closed, overlay-only, and emits a typed `PreWriteValidationReceipt` with timing, repo, scope, checks, graph, overlay, status, and failure summary data.

#30 adds `ReleaseCutoverReceipt` and `npm run cutover:check` as the installed-artifact cutover proof. The gate packs the public release packages, installs them into a clean temporary project, clears current-tool environment resolution, excludes local wrapper/sibling paths, verifies installed canonical bins (`opcore` and `opcore-asp-provider`), binds every command receipt id to its expected canonical command/status/exit, and fails on old-tool/private-path markers or advertised `not_implemented` release commands.

#120 adds `AspDogfoodReceipt` and `npm run asp-dogfood:check` as advisory/shadow evidence that the independent ASP manager can install/enroll Opcore as a Core check provider and record host-owned decisions separately from provider assessments. The receipt uses temporary `ASP_HOME` state, records `opcore-asp-provider --stdio` manifest/bin evidence, co-records retained current-tool guardrails, and keeps `oldToolReplacementClaimed: false`; it is not a cutover, host authority claim, public standard-readiness claim, or `opcore asp` route.

Top-level runtime lifecycle helpers are not public command groups. If shared lifecycle commands are adopted later, they need a new architecture decision and release acceptance criteria; graph daemon lifecycle remains graph-owned under `opcore graph`.

There is no public `opcore asp` router group in this release. ASP Core check integration is launched as the package-owned `opcore-asp-provider --stdio` provider process from `@the-open-engine/opcore-asp-provider`; it is not an ACE descriptor route and it must not execute current-tool wrappers or old `rox`, `crg`, or `cix` binaries. Issue #153 adds a hidden host-launched warm stdio route under the Opcore advanced entrypoint for inspect/edit/check sessions; it stays out of public help and manifests, keeps bounded singleton/idle state under `.opcore/asp/`, delegates check/evaluate to the cold provider mapping, never auto-spawns, and never mutates source files.

## Ownership Boundaries

| Area | Boundary |
|---|---|
| `packages/contracts` | Public wire contracts, schemas, command payloads, adapter request/result envelopes, validation shapes, graph query contracts, and generated TypeScript types. |
| `crates/graph-core` | Planned Rust graph core for source extraction, parser integration, SQLite/WAL persistence, freshness metadata, watch daemon state, hot query execution, and clone index analysis through the existing native binary. |
| `packages/graph` | npm facade/package track for graph commands, public graph command adapter, native graph-core loading, and graph JSON output. It must not duplicate graph-core internals or depend on the aggregate CLI. |
| `packages/edit` | Edit planner, public edit command adapter, patch/tree edits, symbol-aware orchestration, graph-backed discovery integration, and whole-plan validation. It consumes contracts and graph queries, not graph internals or the aggregate CLI. |
| `packages/validation` | Mechanical checks, public check/validate command adapters, validation manifests, failure policy, hypothetical validation, graph-aware rule orchestration, and `check`/`validate` reporting. It consumes contracts and adapters, not edit internals or the aggregate CLI. |
| `packages/validation-rust` | Rust validation adapter rules, temporary workspace materialization from validation file views, and Cargo/native-tool-backed checks exposed to validation through contracts. It does not own host decisions or current external guardrail replacement policy. |
| `packages/validation-typescript` | TypeScript adapter rules, compiler-backed checks, and TypeScript graph-aware validations exposed to validation through contracts. |
| `packages/validation-clone` | Duplicate-code validation adapter rules over `ValidationCheckContext.fileView`, with an injected native clone invoker supplied by CLI composition. It does not own graph-provider status, daemon lifecycle, host decisions, SAST/security policy, or scoring. |
| `packages/asp-provider` | Standalone ASP Core check provider facade, stdio JSON-RPC lifecycle, ASP changeset-to-validation-overlay mapping, provider-owned diagnostics/coverage, read-set freshness binding, and provisional manifest metadata. It does not own host decisions, authority, gates, apply behavior, ACE launch, or current-tool execution. |
| `packages/fixtures` | Golden repos, graph snapshots, reference evidence, canonical command conformance cases, and release/cutover fixtures. |
| Release descriptors and manifests | npm package metadata, ACE descriptor metadata, ASP provider install metadata, native platform package declarations, provenance, and checksums. |
| `scripts/setup-current-tools.sh` | Current-tool bootstrap only. It must keep wrappers pointed at external ACE-managed tools until release/cutover issues say Opcore packages are production-ready. |

No package may import implementation internals across graph, edit, or policy tracks. Shared shapes move to `packages/contracts` before use across boundaries.

## Native Artifacts And CI

#21 adds the Cargo workspace, `crates/graph-core`, JS/npm wrapper package work, platform artifacts, checksums, Rust validation adapter coverage, and Rust CI gates.

The Rust graph-core sidecar is packaged through optional Opcore native packages, not through local graph-package native output. The supported Opcore alpha targets are exactly `darwin-arm64`, `darwin-x64`, and `linux-x64`, provided by `@the-open-engine/opcore-graph-core-darwin-arm64`, `@the-open-engine/opcore-graph-core-darwin-x64`, and `@the-open-engine/opcore-graph-core-linux-x64`. The graph package facade resolves only the matching optional package metadata, validates `metadata.json` and `opcore-graph-core.sha256`, invokes the sidecar with schema-versioned JSON/NDJSON `GraphDaemonRequest` envelopes, and maps native/process/protocol failures to typed GraphProvider statuses instead of empty graph data. It must not fall back to workspace-local builds, sibling checkouts, `.ace/runtime`, PATH tools, or PATH-discovered tools; unsupported platforms, including Windows, fail with a clear unsupported-platform status.

Release artifacts must include:

- npm-first install through the TypeScript facade.
- platform-specific native graph-core package artifacts for `darwin-arm64`, `darwin-x64`, and `linux-x64`.
- checksum/provenance data for each native artifact.
- CI gates for Node, TypeScript contracts, Rust build/test, native wrapper loading, fixture conformance, and a release-dry-run aggregate job that downloads all supported native package artifacts before release or cutover receipts claim cross-platform readiness.
- ACE/Zeroshot consumption through generated wrappers and descriptors, not direct source-tree paths.
- ASP provider provisional manifest metadata as install metadata only; it must not grant authority, trust, or gate permission.

#8 adds Wave 1 staged source extraction in Rust graph-core for TS, TSX, JS, and JSX using OXC parser crates. Query responses may now return GraphProvider-compatible File, Class, Function, Type, and Test facts with typed extraction diagnostics. #9 adds the GraphProvider SQLite/WAL store at `.opcore/graph/graph.db`, freshness metadata, deterministic full-snapshot replacement, store-backed nodes/edges/neighbors/symbols selectors, and the #19 direct-reader reference evidence projection.

#10 adds `opcore graph build`, `opcore graph update`, `opcore graph watch`, and `opcore graph status --json` over the Rust graph-core pipeline. Build performs deterministic full-repo discovery, extraction, atomic store replacement, cached FileFacts persistence, phase timing, and WAL budget checks. Update compares stored and current file hashes, reparses changed files, removes deleted-file facts, reuses cached unchanged facts, records changed/deleted file summaries, and marks full rebuilds explicitly when cache state is insufficient. Build/update/status are scoped only by explicit `--paths`; `OPCORE_GRAPH_WATCH_PATHS` is watch-only default. Watch runs a polling Rust daemon with `.opcore/graph/daemon/{pid,state.json,daemon.log}` lifecycle artifacts, ignore-file and watch-path filtering, dirty/deleted reconciliation, graceful shutdown, and WAL checkpoint enforcement. #11 adds read-only store-backed `opcore graph impact`, named `opcore graph query`, `opcore graph review-context`, and `opcore graph detect-changes` envelopes; stale stores, schema mismatches, invalid daemon state, and unsupported query shapes return typed failures without graph payload arrays. #12 adds Rust graph-core FTS5 search with signature projection, `nodes_fts` schema ownership, full and incremental index maintenance, typed search failures, and canonical `opcore graph search` routing through the TypeScript graph adapter. The JSONL sidecar supports `ping` and `health` for lifecycle/status only; long-tail parser coverage remains follow-up graph-core work and must stay behind GraphProvider contracts.

Graph pipeline command failures use router status `error` with exit code 1 and the typed GraphProvider failure status; the TypeScript facade must not fabricate pipeline summaries when graph-core returns no pipeline. `status` and `health` are read-only over existing store/lifecycle artifacts and must report missing stores without creating `.opcore/graph/graph.db`.

#151 adds `opcore-graph-core clone` as a subcommand of the existing native binary, not as a daemon or new native package. It accepts `CloneAnalysisRequest` over stdin and emits `CloneAnalysisResult` using `opcore.clone.v1`. Committed analysis may refresh `.opcore/clone/clone.db`; hypothetical overlays must be analyzed ephemerally and must not write the clone database.

## Migration Impact

New implementation issues must reference this ARD before changing language boundaries, CLI routing, package ownership, or release descriptors. Downstream issues #1, #2, #3, #5, #6, #7, #8, and parent covibes/covibes#2287 must treat this document as the runtime/CLI decision source.

Before replacing current external tool behavior, add golden/reference fixtures and contract tests for command output, graph query behavior, edit-plan validation, and validation manifests.

## Rust Validation Adapter

#20 adds `@the-open-engine/opcore-validation-rust` as a validation adapter package composed by the CLI beside TypeScript checks. Stable check ids are `rust.source-hygiene`, `rust.fmt`, `rust.cargo-check`, `rust.clippy`, `rust.rustdoc`, `rust.import-graph`, `rust.dead-code`, `rust.graph-signals`, `rust.unused-deps`, and `rust.function-metrics`. These are provider assessment checks; ASP hosts decide allow, deny, or degraded coverage later. `rust.graph-signals` is graph-provider-backed evidence over public contracts only; it does not replace the retained mechanical cargo/rustdoc/clippy/Rox guardrails.

Rust checks read candidate files through `ValidationCheckContext.fileView`. Checks that need Cargo or native tools materialize a temporary workspace from after-state content, apply write/delete overlays there, and clean up without mutating the real worktree. `.rs`, `.inc`, and `Cargo.toml` are adapter-owned inputs. Cargo.lock-only changes remain retained compatibility until a later decision expands Rust adapter ownership.

`opcore status --json` and `opcore doctor --json` expose Rust adapter status, toolchain availability, degraded checks, retained compatibility notes, `currentUsage` metadata for Opcore/Orchestra/CoVibes/gateway consumers, and temporary workspace requirements so #21 can decide daemon/cache/check UX without rediscovering Rust coverage. Missing `cargo`, `rustfmt`, or `clippy` makes the Rust foundation unavailable; missing `rustdoc` is reported as degraded retained compatibility instead of disabling the core `rust.fmt`, `rust.cargo-check`, and `rust.clippy` foundation.

## Clone Validation Adapter

#151 adds `@the-open-engine/opcore-validation-clone` as the duplicate-code validation adapter package. The stable check id is `clone.duplication`; it requiresGraph:false, reads candidate after-state through `ValidationCheckContext.fileView.readAfter`, and emits line-free duplicate-code diagnostics with stable clone-class identity. The adapter receives its native invocation function from Opcore validation composition, so it does not import graph-core loaders, raw SQLite, graph internals, or the aggregate CLI.

Clone findings are policy diagnostics for duplicate code only. They must not use SAST/security wording, all-stack coverage wording, a blended score, or old-tool replacement wording.

## ASP Provider Facade

#118 adds `@the-open-engine/opcore-asp-provider` and its `opcore-asp-provider --stdio` bin as an independently launchable ASP Core check provider. It handles `initialize`, `initialized`, and `check/evaluate`; advertises Opcore-owned check metadata; requests read-only workspace permissions; maps ASP create, modify, delete, and rename changesets into validation overlays; and uses host `workspace/listTree` and `workspace/readBlob` callbacks for all ASP-owned content access.

The provider composes the same TypeScript and Rust validation checks as the Opcore validation command composition. Assessment output must bind `validAsOf.baseline`, `validAsOf.changesetDigest`, and `validAsOf.blobs` to the exact host input/read set, use provider-owned diagnostic sources and fingerprints, and represent graph/toolchain/provider gaps as degraded or unsupported coverage rather than clean exhaustive coverage.

The provider facade must not emit host-owned decision, authority, assurance, transaction, gate, or apply fields. ASP hosts decide policy outcomes. The provisional provider manifest is install metadata only and must not grant trust, authority, or gate permission.

#120 dogfood keeps that boundary explicit: the ASP manager/host may produce advisory or shadow decisions and receipts, while Opcore only produces provider assessments/provenance. Unsupported inspect/edit ASP surfaces stay degraded or retained blockers until request/response mappings, freshness behavior, and tests exist.

## Single-Bin Router Split

The `opcore` package intentionally ships one public bin: `opcore` points to `dist/index.js`. The root router owns the product facade routes: scan, status, check, init, measure, and try. It also dispatches advanced work-router groups through the same public bin: graph, inspect, edit, check, validate, status, and doctor.

The parallel source trees under `packages/opcore/src/` and `packages/opcore/src/advanced/` are not duplicate-router drift. `graph-provider-client.ts` exposes product-facade `opcoreGraph*` helpers, while `advanced/graph-provider-client.ts` exposes `cliGraph*` helpers and adds `cliGraphSearch` for inspect/edit routing. `validation-composition.ts` exposes the product-facade validation runner and check adapter, while `advanced/validation-composition.ts` exposes `validateCommandAdapter` and `editValidationRunner` for work-router flows. Both trees remain live because the facade and advanced router groups have different command and composition needs.

Both trees intentionally retain the provider id `opcore-graph` as a transitional internal contract/artifact name. Internal advanced implementation paths and generated evidence must not be introduced as separate public Opcore product branding or a second public bin.

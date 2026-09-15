# Opcore Architecture

## Decision

Keep the protocol definition, private bundled-provider harness, providers, and user-facing tools in one Rust package around immutable source views:

1. `opcore check` runs the fast built-ins directly for local Git use.
2. `opcore check --providers ... [--roots ...] [--comparison introduced|all]` uses a private local harness to run an explicit provider subset against the repository or project-aware source focuses. `all` selects every provider; legacy `--native` remains fast plus Rust-native.
3. `opcore serve --stdio [--profile fast|rust-native|node-native|python-native]` exposes one distinct ASP Core v1.0 provider process.
4. `opcore sense` performs exact local before/after dependency analysis outside ASP Check.

The complete ASP `1.0` definition is maintained under `asp/`; its upstream starting revision and current aggregate digest are recorded in `asp/SOURCE.json` and tested. The bundle contains the normative specifications, schemas, examples, decisions, governance/conformance documents, and fixtures. It deliberately excludes the old reference host, manager/daemon, provider catalog, setup wizard, and website.

There is no persistent graph, daemon, provider registry, plugin loader, inspect/edit/apply capability, report history, or second installation product. Native coverage is three fixed language backends behind explicit selection, not a general tool-execution framework.

## Ownership

```text
default Check -----> fast kernel ------------------------------------------> Assessment

provider Check -> provider-aware Git capture -> focus/context projection -> private harness
                                                             |-> fast process --------> Assessment --+
                                                             |-> Rust-native -> Cargo -> Assessment --|
                                                             |-> Node-native -> npm/tsc -> Assessment -+-> Decision
                                                             +-> Python-native -> Pyright/mypy --------> Assessment --+
```

The fast kernel owns source identity, rule dispatch, comparison, coverage, diagnostics, caching, deadlines, and deterministic output. Language adapters own parsing and language conventions. Provider transports own strict protocol validation and assessment mapping.

The private bundled-provider harness owns the callback grant, provider lifecycle, response validation, freshness revalidation, diagnostic-source attribution, and the local `allow`/`deny`/`indeterminate` composition. It is not a conforming ASP Core outer host or an adoption-evidence producer: it exposes no `host/status`, `host/capabilities`, or `host/evaluateChangeset`, maintains no policy/authority registry or provider enrollment, and emits no host receipt. It also does not discover external providers, apply edits, expose a daemon, or give a provider a repository path. Each bundled profile runs as a separate invocation of the same executable; provider assessments cannot contain host-owned decision, authority, assurance, policy, receipt, transaction, or apply fields.

## Source Snapshots

Fast Git and ASP adapters fully capture supported request content into one concrete `SourceSnapshot` before evaluation. A snapshot owns:

- an ordered logical-path to immutable-source map;
- a content-derived view identity;
- synchronous path iteration and reads with no hidden I/O.

The ASP adapter captures content only through `workspace/listTree` and `workspace/readBlob`. The Git adapter captures committed baselines through tree/blob objects and reads explicit index/worktree states. The fast engine performs no source I/O after capture and never executes project-native tools.

Provider-backed Check has a separate capture because native tools need manifests, lockfiles, and configs intentionally outside `SourceSnapshot`. Path discovery first applies the union of selected provider envelopes: recognized source for fast; JS/TS, JSON, and fixed npm/project controls for Node; `.py`/`.pyi` plus fixed checker configs for Python; and a fixed repository-wide Cargo build-input envelope for applicable Rust. The Rust envelope contains Rust/Cargo controls, native build sources, schema/codegen inputs, common textual compile resources, and exact license notices, retaining workspace/path dependencies and ordinary literal includes without guessing arbitrary binary/media/data inputs. Filtering occurs before the 10,000-file/256-MiB request bounds. A native build that actually needs an omitted input remains unavailable/incomplete; the host never widens capture in response to repository execution.

Within that envelope, capture retains exact before/after bytes for tracked and non-ignored untracked regular files, ignores directory, Gitlink, and symlink entries, constructs content-addressed ASP ChangeSets, and revalidates HEAD, index, the filtered path set, bytes, and file generations after all selected providers finish. A selected tracked regular file replaced by a non-regular worktree entry still fails closed. Staged mode compares HEAD with stage 0 and ignores unstaged/untracked bytes; worktree mode compares HEAD with current bytes. Provider-backed Check does not support `--base`, committed/tree, explicit-path, or direct `--all` scope modes.

Root selection is validated before capture. Each non-overlapping root is a focus, not a claim that a source subdirectory is a standalone build: fast uses the exact rebased focus; Node/Python retain the nearest applicable ancestor project configuration; Rust retains repository context and selects the focused package as Cargo's working directory. Each root/provider pair receives its own callback workspace and reports both focus and context; result rendering restores repository-relative paths. Roots never relax bounds or share a provider process/evaluation.

The harness grants those bytes through `workspace/listTree` and individually bounded `workspace/readBlob` callbacks. ASP v1.0 callbacks contain paths and bytes but no executable or other filesystem modes. Each native provider reconstructs candidate and, only when required for introduced-finding subtraction, baseline trees under private temporary directories rooted at a fixed host temp location outside the candidate repository; ambient temp variables cannot redirect this scratch. Every callback file is a regular owner-read/write file (`0600`). Mode-sensitive builds are outside this slice and may fail or behave differently. Native tools are never pointed at the user's worktree during normal execution, so ordinary outputs land in scratch. That is not source or filesystem confinement: executed code may mutate the materialized copy or any other host-writable path, and external dependencies, configs, wrappers, plugins, and toolchain components may read outside the granted snapshot. Diagnostic semantic keys come only from immutable callback bytes.

After native execution, the provider revalidates the materialized root directory's device/inode identity and boundedly re-enumerates scratch. Every callback file must still be regular and byte-identical. Rust alone permits a generated root `Cargo.lock` when none was supplied and hashes it into evidence; Node removes generated `node_modules`; all other additions or removals fail. This is post-run detection of residual scratch mutation, not containment: transient or restored writes and mutations outside scratch are neither prevented nor proven absent.

## Repository And Snapshot Identity

Local repository identity is a domain-separated digest of the canonical `git --git-common-dir`. Discovery resolves a relative common-directory result against the invocation directory, so commands from a normal clone's subdirectories retain the repository root, common directory, and worktree-local index. This identity scopes storage only; it never proves content freshness.

Repository discovery distinguishes a directory outside Git from Git execution or repository-infrastructure failures. The post-write hook skips the former; missing Git, corrupt repository metadata, and other discovery failures still block with a diagnostic.

Reusable identities are deliberately narrow:

```text
RepositoryId = H(canonical Git common directory)
ContentViewId = H(sorted(logical-path-bytes, language, language-mode, actual-content-sha256))
FileFactKey  = H(fact-kind, content, language-mode, parser-options, fact-ABI)
```

The ASP ChangeSet digest is computed from the original validated wire object using the pinned private interoperability canonical-JSON algorithm. Request-local assessment evidence separately records the exact content views and blobs read; it is never a reusable freshness cache.

Linked worktrees share cached facts for identical blobs and parsing modes. Different branches reuse unchanged file facts. Dirty and hypothetical states add overlays without mutating a shared base. There is no time-based staleness.

Local Git scopes are exact:

| Scope | Base | Overlay |
|---|---|---|
| committed | `HEAD^{tree}` | none |
| staged | `HEAD^{tree}` | stage-0 index entries; unmerged stages refuse |
| changed | `HEAD^{tree}` | current worktree plus untracked contents, which supersede index content |
| explicit | `HEAD^{tree}` | requested current paths only |
| changed/staged with `--base` | resolved `REF^{tree}` | exact current worktree or stage-0 index |
| `--tree` | optional resolved base tree | resolved target tree; no index/worktree reads |
| hypothetical Verify | ASP-selected prior view | validated ASP ChangeSet overlay |
| hypothetical Sense | exact current worktree | strict local write/delete request overlay |

Git blobs are read with object plumbing. The adapter never calls `git write-tree`, hooks, filters, external diffs, or lifecycle code. It preserves Git path bytes internally, refuses symlinked working-tree paths/parents, treats missing sparse skip-worktree files as their stage-0 index contents, hashes bytes actually read, and verifies index/worktree capture stability with bounded retry before returning `source_changed_during_capture`.

One root `.opcore.json` holds Verify and Sense thresholds, documentation bindings, literal target exclusions, provider roots, native selection, coverage acknowledgments, and built-in workflow overrides. Its strict 256 KiB schema rejects duplicate/unknown fields, nulls, unsafe paths and bounds, and symlinks. Objects merge defined fields while arrays replace; workflows inherit directly from repository settings. Documentation bindings remain repository-wide. Compiler configuration and execution authorization remain with their existing owners.

Configuration capture follows the selected source view: worktree, stage-0 index, or immutable target tree. One resolver produces request-local effective settings and field origins; full and evaluator-specific digests bind assessment identity. Introduced comparisons use the selected thresholds for both views. Freshness validation covers source and configuration, retrying once on change. Fast target exclusions apply during path discovery before source reads; Sense reports incomplete graph knowledge caused by narrowed scope. Native roots preserve necessary compiler context and reject exclusions the backend cannot honor.

`run post-edit`, `run pre-commit`, and `run ci` compose the existing evaluators under one resolved configuration. Post-edit compares worktree changes with HEAD and defaults to allowing partial Sense coverage; explicit coverage settings may tighten that behavior. Pre-commit checks full staged Verify/native and introduced Sense. CI checks an immutable target, defaulting to HEAD, with an explicit Sense base. Missing required native prerequisites fail the workflow; configuration never authorizes native execution. `status` and `doctor` inspect the same selected configuration view without evaluating source. `rules --schema` generates the editor schema from the implementation.

## Cache

The default local fast-fact cache is under the platform cache directory, namespaced as `opcore/v1/<repo-key>/`. ASP hosts may deny fast-provider cache persistence; that provider then uses a bounded process-local cache and reports `disabled` or `miss` honestly.

Persistent caching is intentionally limited to file parse/metric facts keyed by content, exact language/dialect/target mode, parser options, and fact ABI. Request-local Go module bytes influence resolution and graph-view identity but are never persisted as facts or topology.

Project context and assessment fragments remain bounded process-local memoization until their complete keys are proven.

Native assessment caching is disabled. Rust gets a fresh target directory, Node gets an ephemeral dependency tree, and mypy gets an ephemeral cache; npm may reuse its explicit host cache. Cargo/npm/checker executables and their PATH-selected rustc/Node/Python runtime launchers are hashed and revalidated. This still says nothing about all ambient toolchain or installed-package bytes: declared host tool/cache/environment paths are neither copied nor sanitized by Opcore, and native assurance remains advisory without an external host sandbox.

The cache root must be absolute, private, non-symlinked, outside candidate and Git-common-dir trees, and subject to byte/entry quotas. Entries use fixed hex-derived names, private exclusive temporary files, a bounded header containing domain/schema/key/payload length/checksum, validation before allocation/deserialization, and non-replacing atomic publication. Concurrent unequal payloads for one key are a determinism defect. Corruption is ignored and recomputed; request paths do not race to quarantine it. Best-effort durability is sufficient because cache loss is always a safe miss.

## Check Profiles

### Fast built-ins

Always available without repository code execution:

- syntax parsing;
- physical file length and maximum line length;
- function length, parameter count, nesting depth, and cyclomatic complexity.

### Rust-native Cargo Check

The opt-in Rust-native profile is deliberately one of two fixed command shapes:

```text
cargo check --workspace --all-targets --message-format=json [--locked]
cargo check --all-targets --message-format=json [--locked]  # selected package
```

It is applicable only when the effective working root contains `Cargo.toml`. A repository-root request uses `--workspace`; a focused package runs from that package without `--workspace` while its parent workspace files remain materialized. A captured context-root `Cargo.lock` selects `--locked`. Cargo comes from the absolute `OPCORE_CARGO` path or an executable found on `PATH`; the provider also binds and revalidates the `PATH`-selected rustc launcher. The subprocess inherits a small named set of host variables needed to locate its toolchain and Cargo/Rustup homes; this is narrower than ambient inheritance but is not a sanitized or secret-free environment, and the native manifest declares those stores as potentially writable. All temporary-directory variables and `CARGO_TARGET_DIR` point to fresh provider-private scratch. Executable hashing, process execution, and the post-run identity checks share the request's cumulative deadline. Rustup-selected toolchain contents and ambient Cargo homes remain external state rather than a content-addressed environment. Cargo also receives `CARGO_NET_OFFLINE=true`, bounded captured output, and cancellation. Offline mode asks Cargo not to fetch; without an OS sandbox it cannot prevent repository-controlled code from opening the network. Structured compiler errors and warnings become deterministic ASP diagnostics; duplicate diagnostics produced by multiple target passes are collapsed and generic rustc failure notes are ignored. An unavailable tool/dependency, malformed output, timeout, unstructured failure, or missing successful `build-finished` message never becomes a fabricated clean result. Introduced comparison runs the baseline only if the candidate produced findings. A successful baseline supplies an exhaustive before-set for exact fingerprint set subtraction, and an absent baseline project supplies the empty set. A failing baseline is incomplete because compiler short-circuiting can hide other crates or targets.

### Node-native TypeScript Check

This profile applies to a project context with `package.json`, a root npm lock, and one or more exact `tsconfig.json` or `tsconfig.*.json` files. It runs a fixed offline `npm ci` with lifecycle scripts, audit, funding, notifications, color, and progress disabled. It then hashes and invokes only `node_modules/.bin/tsc` for each exact config using `--noEmit --pretty false --listFiles --incremental false`. npm, `tsc`, and the `PATH`-selected Node runtime are revalidated after execution. The union of compiler file lists is the exact configured semantic universe, matching Cargo's treatment of files outside declared targets. Configured JavaScript and TypeScript diagnostics are retained; sources outside every project remain covered only by fast syntax/hygiene and do not poison the native assessment. Evidence counts configured sources plus unconfigured JavaScript and TypeScript without retaining success paths. ESLint, package scripts, arbitrary commands, pnpm/yarn, and unlocked projects remain outside coverage. Missing offline cache entries, Node, or project-local TypeScript yield unavailable coverage. Compiler diagnostics are stable findings, and the complete configured-project diagnostic set safely supports introduced comparison.

### Python-native Type Check

This profile applies whenever the selected focus contains `.py` or `.pyi`. It prefers a host Pyright executable and falls back to host mypy, configured through absolute environment overrides or `PATH`. The private host selects an interpreter in this order: explicit `OPCORE_PYTHON`, `.venv` under the nearest selected project context, an active virtual environment located inside that context, then a labelled ambient `python3`/`python`. The interpreter is supplied through Pyright `--pythonpath` or mypy `--python-executable`. Its executable and a context-local `pyvenv.cfg`, when present, are hashed into request evidence and revalidated after execution; installed package bytes remain external advisory environment state rather than ASP callback content.

Every exact selected path is passed explicitly. Pyright must return bounded JSON with internally consistent summary counts and a `filesAnalyzed` count at least as large as that set; mypy uses fixed non-pretty/error-code flags, those same paths, and a provider-private cache. An unresolved-import diagnostic under an ambient interpreter makes the assessment incomplete because Opcore cannot distinguish a source defect from an unselected project environment. Under an explicit or context-local environment it remains a finding relative to that chosen environment. The provider never creates, synchronizes, activates, or installs into an environment, runs the program/tests, or invokes Ruff. Pyright may execute the selected interpreter to discover its import environment, and mypy may load configured plugins, so the common trusted-repository boundary remains necessary.

Native JSON retains every bounded diagnostic. Human output groups large result sets by exact rule, file, and `(path, range, rule)` location, prints the leading hotspots, and limits detailed rendering to 50 representative locations. This is presentation-only aggregation; fingerprints, comparison, decisions, and ASP assessment contents remain unchanged.

These controls are execution hygiene, not containment. The private harness launches each provider as a process-group leader; native descendants normally inherit that group, which is killed before the provider is reaped after success, error, timeout, or harness drop. This best-effort cleanup cannot stop a descendant from changing process group/session and provides no network namespace, mount/filesystem confinement, CPU/RSS limit, or secret isolation. Native output therefore carries `host-sandbox-required`, and the harness reports advisory assurance. Use it only for trusted repositories; authoritative use requires an external OS sandbox with explicit mounts, network denial, and descendant/resource control. Native providers are never part of default Check or installed post-write hooks.

ESLint, rustdoc/clippy, Python environment provisioning/runtime tests, and Go compiler/generator execution remain deferred. Any later native capability requires an explicit backend, applicability rules, diagnostic parser, and isolation contract; none is hidden behind a generic plugin runner.

## Language Coverage

### Node

Treat JavaScript and TypeScript variants as one Node family. The declared fast envelope is `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.d.ts`, `.d.mts`, and `.d.cts`; extension-selected CJS/ESM and JSX/TSX modes; shebangs; and syntax accepted by the pinned `oxc_parser`. Ambiguous `.js` stays parser-unambiguous. Fast checks do not inspect package `type`, tsconfig/jsconfig, plugins, or executable configuration and never execute Node. Explicit Node-native selection adds locked project-local TypeScript semantics.

### Rust

Support `.rs` source accepted by stable Rust editions 2018, 2021, or 2024. Fast local discovery uses an adaptive stable-edition parse because the parser deliberately does not interpret Cargo manifests; explicit engine callers can select an exact edition. Built-in source checks use pinned `ra_ap_syntax`; macro bodies are opaque and direct nightly feature gates are unsupported coverage rather than fabricated findings. Only the explicitly selected Rust-native profile executes Cargo/build scripts/proc macros.

### Python

Support `.py`/`.pyi`, UTF-8 and UTF-8 BOM, encoding-cookie recognition, and source files in package, namespace, `src`, and nested-project layouts. Built-in parsing uses the exact pinned Ruff parser and AST crates; a non-UTF-8 declared source encoding is unsupported coverage and syntax outside the bundled grammar is a parser finding. Fast checks make no exact Python minor, interpreter, project configuration, import resolution, or type-authority claim. Explicit Python-native selection adds the chosen host checker's project-aware type/import analysis without provisioning its environment.

### Go

Support `.go` and `_test.go` with exact-pinned `tree-sitter-go` and Tree-sitter runtime crates. The language mode carries source-versus-test plus the compile-target GOOS and GOARCH; all three participate in source and file-fact identity. Built-in facts cover current grammar syntax, function/method/literal metrics, exports, struct/interface shapes, imports, callable fingerprints, and exact token regions. The bounded lexical pass preserves semicolon-insertion line boundaries. Test files retain dependency evidence but do not contribute production exports.

Filename suffix constraints and `//go:build`/legacy `// +build` expressions over known GOOS, GOARCH, and `unix` tags are evaluated against that target. Custom tags, `cgo`, compiler, and Go-release tags remain explicit conditional coverage because no project build context is executed. Sense captures exact root and nested `go.mod` bytes independently for HEAD/worktree, staged, and hypothetical views, reads only the `module` directive, selects the deepest enclosing module, and aggregates production files in one package directory onto a deterministic logical representative. Exact imports within those module prefixes become runtime edges. External modules, `go.work`, `replace`, vendor/GOPATH resolution, generated sources, compiler type checking, and package initialization behavior remain outside the no-toolchain boundary. Malformed relevant module metadata is incomplete, not guessed.

### Protocol Buffers

Support `.proto` syntax with exact-pinned `tree-sitter-proto` and the matching Tree-sitter runtime. The parser accepts proto2, proto3, and edition syntax behind the same bounded structural preflight and UTF-8 contract as the other fast parsers. Opcore never invokes `protoc`; import resolution, descriptor/interface semantics, generated sources, callable fingerprints, and copied-token-region facts remain explicit unsupported Sense coverage.

Metric semantics are language-specific and versioned. Rule documentation and fixtures define treatment of arrow functions/closures/lambdas, comprehensions, match arms, async constructs, boolean operators, and opaque macro bodies.

## ASP Core

All four provider profiles implement the canonical check capability, not a provider-owned Verify verdict:

- lifecycle: initialize, initialized, shutdown, exit;
- utilities: cancellation; `partialResults:false` means it emits no progress;
- callbacks: listTree and readBlob only;
- capability: check/evaluate;
- assessment: status, diagnostics/evidence, requested/covered/degraded/unsupported coverage, validAsOf, provider metadata, timing, and cache metadata.

Local assessment coverage contains `filesConsidered`, `filesCovered`, and detailed `gaps[]` only. Successful files are counted rather than serialized one by one; every unsupported or incomplete path retains its reason.

The fast initialize result advertises `check/1.0`, source `opcore`, scopes `changeset` and `workspace`, comparisons `introduced`/`all`, `partialResults:false`, `incremental:false`, `unsupportedReporting:"assessment-status"`, and `fixes:false`. Every native profile advertises the same capability with workspace scope only. Each has a distinct provider identity, rule source, capability-profile identifier, and manifest while sharing the executable and protocol implementation.

The advertised provider build fingerprint is embedded at compile time and hashes the Rust source, locked build inputs, and the bundled ASP definition. It is distinct from the installed manifest's bounded, stable checksum of the exact executable bytes at rest.

The strict protocol normalizer rejects malformed paths, duplicate/conflicting changes, illegal transitions, baseline mismatch, and incorrect before identities before the kernel sees data. Callback success-shape violations, contradictory identities, and blob hash mismatches are contract failures; explicit host callback errors retain their typed fail class. Directory entries are ignored, source symlinks yield unsupported coverage, and a truncated required listing yields an incomplete assessment instead of silently dropping coverage.

The canonical request requires `changeset`, `scope`, and `comparison`, and accepts one optional provider `configuration` object. Fast accepts strict `{"verify":{...}}` settings; native profiles accept only `{}` because their compiler settings come from callback inputs. Omission and `{}` use documented defaults. `configDigest` hashes the provider ID, capability version, and normalized settings; the host validates it for every assessment status. Compiler input blobs and tool identity evidence retain their separate bindings. Non-schema extensions are rejected. Canonical `priorDiagnostics` and `priorAssessments` are fully shape-validated, including non-null optional properties and recursive provider-data restrictions, then deliberately ignored because every profile advertises `incremental:false`.

The server computes the ASP ChangeSet digest with the pinned current canonical-JSON algorithm. `introduced` is exact set difference by public fingerprint: any fingerprint in the before-set suppresses every matching after occurrence; `all` returns after-state diagnostics. Fast before/after facts share content-addressed entries. Local non-ASP comparison matches the same logical path first and permits cross-path continuity only for one-to-one removed/added files with identical content identities. Rust-native fails incomplete when compiler short-circuiting prevents an exhaustive baseline; Node/Python accept only diagnostic contracts that yield comparison-safe before-sets.

Lifecycle is explicit: spawned -> initialized-pending -> active -> shutting-down -> exited. Duplicate initialize, initialized-before-initialize, duplicate live request ids, and capability work outside active state are typed failures. The read loop remains responsive during evaluation. Cancellation terminates the original request with `-32016` health/retryable; shutdown rejects new work and boundedly cancels/drains active work. Any `exit` notification terminates the process, but it is successful only after `shutdown`.

## Artifact Integrity

Each published platform bundle contains `install.sh`, the executable and its checksum, the root README and its local visual assets, the global agent skill and Codex descriptor, the complete pinned `asp/` definition snapshot, and the root `LICENSE` referenced by `asp/SOURCE.json`. The installed executable and manifests are runtime artifacts, not protocol-definition material. The archive intentionally excludes all four manifests: each embeds an absolute executable path and exact executable checksum, so installation renders them only after the binary reaches its runtime location. The installer also binds command examples in its installed skill to that exact binary, avoiding dependence on a GUI agent's inherited `PATH`. The provider build fingerprint instead binds the compile-time Rust/lock/ASP inputs. Checksums establish artifact integrity only; they do not grant trust or host authority.

Stable semver tags publish two versioned POSIX ustar bundles, Linux x86-64 and macOS arm64, to one immutable GitHub Release. A bounded `SHA256SUMS` names exactly those archives, and release staging writes the same two digests into the npm tarball. The dependency-free npm facade has the same version as the tag and downloads only its matching public asset; unsupported systems fail before network access. Its extractor requires the downloaded checksum matrix to match the npm binding, then verifies the compressed digest, tar headers, entry types and paths, the fixed bundle shape, the four README visuals, and the bundle's inner executable checksum before writing a private temporary tree. It rejects links, duplicate members, path traversal, unknown top-level content, malformed trailers, and excess compressed or expanded bytes.

The installer discovers Codex and Claude independently through their configured roots or default home directories. It installs every detected agent unless `--agent` restricts the selection. Both integrations share one executable, while each has its own skill, manifests, receipts, and standalone uninstaller. Codex skills default to `$HOME/.agents/skills`; Claude skills stay under its configuration root.

Shared ownership lives under `$HOME/.local/share/opcore/owners/<binary-path-sha256>`, outside an npm package that an update may replace. Every initialized registry has fixed Codex and Claude slots. A slot contains either one exact inactive sentinel or the literal canonical runtime and skill roots of an active owner. Missing, extra, symlinked, or malformed slots stop installation and removal. Each v6 receipt binds its agent, those paths, the ownership directory, and the installed artifact digests. Historical v5 receipts have no shared-ownership fields. A default upgrade validates a selected legacy owner's receipt before adopting its executable and creating the registry; old v5 uninstallers reject v6 before touching the shared binary.

A directory lock serializes installation and removal for each binary path. The installer checks every selected destination before writing integrations, activates each owner slot, publishes all selected artifact receipts, then enrolls hooks. A slot is deactivated only after its receipt is removed, so interruption cannot turn a custom-root owner into invisible state. Hook state starts as `pending`; successful enrollment changes it to `yes`. A hook failure leaves both agents' receipts bound to the updated binary, so either removal order works. `--no-hooks` skips enrollment and preserves existing hooks. Restricted installation refuses to upgrade a binary another agent owns; default upgrades require every owner in the detected selection. Default removal uses recorded roots, including custom paths, and deletes the executable after the last owner leaves. Standalone uninstallers bind the original home and destinations.

The npm postinstall runs this same verified bundle installer with the native executable inside the package directory. `OPCORE_AGENT` restricts its otherwise identical discovery. Canonical v2 package state contains up to two distinct per-agent v1 records sharing the archive and binary identities; the reader also accepts historical single-agent v1 state. Package replacement can recover owner locations from the external registry. Recovery requires the installed binary to match the verified archive, and conflicting locations stop installation.

The command wrapper hashes the native binary and verifies its package version and target before each launch. If native state is absent or invalid, help and package-version output remain available; doctor/status return bounded setup diagnostics without executing the binary. `setup` retries verified installation. `setup --no-hooks` or `OPCORE_NO_HOOKS=1` installs only the verified CLI, with a package-local digest receipt and no agent directories. It refuses existing agent ownership and unknown or modified binaries. A package lock serializes npm setup and removal. Failed state publication restores the previous CLI bytes or removes the newly installed binary.

Since npm no longer runs uninstall lifecycle scripts, `opcore uninstall` verifies every recorded integration's cleanup inputs before invoking its digest-bound standalone uninstaller. It saves the remaining owner after each successful removal, so a later hook failure can be retried. CLI-only removal verifies its receipt and binary before deleting them. A subsequent `npm uninstall` removes the package itself. npm installation never tells users to put the private native directory on PATH; public commands use the wrapper.

The publication job runs only after the existing Rust, policy, coverage, portability, installer, user-journey, npm-facade, and documentation checks pass. It requires a public repository because unauthenticated npm consumers must reach the release assets and npm provenance does not cover private-source publication. Repository administrators must enable immutable releases, protect release tags, reserve the npm package for the first publication, and configure npm trusted publishing for the exact workflow and `release` environment. OIDC is the normal publish credential; an optional granular token exists only for the one-time package bootstrap.

The `docs` CI job builds the source-generated static site and checks local destinations and HTML anchors. After a successful push-triggered CI run, `docs.yml` rebuilds that exact source and publishes the complete version tree through GitHub Pages at `https://the-open-engine.github.io/opcore/`. Main updates `dev`; a completed release adds an immutable `vX.Y.Z` snapshot and updates `stable`. Pull requests validate the site. The CLI, API, and provider references come from the same source revision as the guides.

## Performance Model

Warm provider evaluation, cold CLI startup/Git acquisition, workspace enumeration, cache reuse, and request RSS are measured separately. The profile fixtures retain those observations for investigation, but elapsed time and RSS have no release thresholds. Cache correctness and bounded completion remain test requirements.

Native costs are intentionally reported separately:

| Dimension | Fast | Rust-native | Node-native | Python-native |
|---|---|---|---|---|
| Setup | Bundled | Cargo/toolchain and locked dependencies already local | npm, npm cache containing the root lock, and locked project `typescript` | Host Pyright or mypy plus the intended Python environment |
| Repository scaling | Linear in selected supported source bytes | Repository-wide fixed Cargo input envelope plus the selected package/workspace graph and targets | Locked dependency extraction plus each exact `tsconfig*`; source work follows the TS project graph | Checker traversal follows explicit selected Python files/import graph |
| Check-time compute | Bounded parser/metric passes with reusable facts | Fresh workspace or focused-package `cargo check --all-targets` | Fresh offline `npm ci`, then one `tsc --listFiles` pass per config | One Pyright or mypy explicit-file pass |
| Memory/disk | Bounded snapshots and content-addressed facts | Compiler memory plus fresh source/target trees | npm/tsc memory plus fresh source/dependency tree | Checker memory plus source tree and small ephemeral mypy cache |
| Worktrees/concurrency | Identical file facts safely shared | No target reuse; one Cargo per selected root/request | npm cache may be shared, dependency trees are not | No assessment/cache reuse; each selected interpreter/environment is request-bound |
| Language value | Syntax/hygiene for all seven families; metrics for Node/Rust/Python/Go | Rust cross-file/crate compiler semantics | TypeScript and config-admitted JavaScript semantics with explicit selected-file coverage | Checker-specific Python type/import semantics with explicit selected-file coverage |

The ASP provider admits one active evaluation per stdio process, and the private harness runs selected providers and roots sequentially. The host captures one bounded provider-aware repository envelope, then projects one focus/context workspace per provider run. Focused roots reduce acquisition, callbacks, materialization, and native tool scope for fast/Node/Python; applicable Rust retains its fixed repository-wide Cargo envelope while narrowing Cargo's package scope. Native file/blob and output/wall-time bounds prevent unbounded protocol state, but child tools choose their own worker behavior and the OS does not cap CPU, RSS, descendants, or filesystem reach. Reports expose elapsed milliseconds per provider so real check-time cost is visible without promising a service level. Consequently there is no native latency or memory service-level claim yet; those require the sandbox and controlled benchmarks.

Default thresholds and hard bounds are versioned policy: the ordinary line threshold is 512 bytes with a 1 MiB hard ceiling; other hard bounds are an 8 MiB NDJSON frame, 4 MiB source file, 10,000 files/request, 256 MiB total source bytes, 256 levels of parser-input structure, a worker pool no larger than available CPUs or 4, 10,000 diagnostics, 8 MiB assessment JSON, 16 MiB cache entry, and 2 GiB cache root. Exceeding or truncating required coverage yields non-clean incomplete/unsupported status; it never silently drops evidence.

Recursive parser inputs are bounded before calling parser or AST-fold code. The guard covers delimiter/type nesting, indentation and branch chains, unary/binary/postfix expression chains, nested block operands, and formatted-string interpolation density. This is a conservative resource-safety envelope: exceptionally deep valid source is explicit unsupported coverage, never a process crash or fabricated clean result.

## Agent-Signal Boundary

Verify does not detect clones or build a graph. Local Sense may enforce exact
nontrivial source/callable/token-region duplication, bounded explicit module interfaces, and
exact documentation ownership for mechanically important modules. These rules
reuse path-independent parser facts and exact request-local comparison; they do
not infer semantic similarity or require a symbol/call graph. The exact contract
is specified in [Agent signals](agent-signals.md).

## Dependency Sense

Sense is specified in [Dependency Sense](sense.md) and [Agent signals](agent-signals.md). It reuses immutable source capture and content-addressed parser facts, then assembles and discards exact request-local topology and policy state. Runtime cycles, exact duplication, bounded explicit interfaces, and documentation obligations are blocking only when introduced. Coupling and impact observations remain inspectable.

Default Sense compares selected HEAD dependencies with an exact worktree overlay. `sense --staged` instead compares HEAD with stage 0, including selected Go module metadata, configuration, and referenced documents; it ignores worktree and untracked bytes. `sense --tree <target> --base <base>` compares immutable trees. `sense --hypothetical` compares the exact current worktree with an in-memory source/Go-module/documentation overlay and binds the request digest to freshness. A proposed configuration write may change documentation bindings only; all other settings must remain semantically identical. Every mode uses read-only Git plumbing. Go graph views also bind the selected `go.mod` content identities.

Sense is not exposed by the ASP check provider. It never persists dirty snapshots, resolved edges, comparisons, or a mutable current graph, and it never uses SQLite, a daemon, watchers, FTS, timestamps, compiler configuration, or repository executables.

## Rule Contract

Every rule declares source namespace/id, supported language modes, scopes, comparisons, workspace/project context requirements, truncation behavior, fingerprint ABI, and limits. Missing required context produces explicit incomplete/unsupported coverage. File-local rules never enumerate the workspace.

## Extension Boundary

Future ASP dimensions remain independent capabilities:

- `inspect`: may own a graph/search index keyed by its own snapshot identity.
- `edit`: may propose content-addressed edit plans but never apply them.
- general host discovery, receipts, transactions, and apply remain outside Opcore; the private harness only composes bundled check assessments into a local decision.

Adding Sense, inspect, edit, or another native backend beyond this fixed set must not widen the fast provider's requested permissions or introduce a privileged fast path.

## Agent Hook

The installer-managed Codex/Claude `PostToolUse` adapter runs the post-edit workflow in-process with worktree configuration. It uses the payload only for a bounded `cwd` hint and skips confirmed non-Git directories. Verify findings, required coverage failures, Sense findings, and incomplete evaluation return intervention feedback to the agent. Allowed partial Sense coverage produces one hint. The hook runs after the tool and does not prevent writes, undo commits, or enforce final handoff; pre-commit and CI run their own workflows. It never parses patches or invokes native providers.

User-level hook configuration merges additively. A path-bound install receipt plus hook receipt makes same-path updates and owned removal deterministic; pending hook state permits retry after an interrupted configuration. Removal executes only a receipt-matching installed binary or an explicit trusted recovery binary. Default installation enrolls hooks after publishing every selected installation receipt. The shell installer's `--no-hooks` skips enrollment and preserves existing hooks; npm's CLI-only setup creates no agent integration.

The same installed matcher also covers Bash and all MCP tool calls. Read-only calls can trigger a check; the adapter doesn't classify MCP tools by guessed write names. Doctor inspects owned hook configuration and receipts without changing them, but host trust and session activation remain unverified until a host-level edit smoke test observes execution.

## Documentation Build

`src/cli_args.rs` owns the shared Rust command definitions used by the executable and the build-only documentation generator. `scripts/build-docs.sh` renders the overview and guides with rustdoc, derives the CLI reference from those definitions, and generates the public Rust API reference under `target/site/`. The public crate boundary remains `src/api.rs`; provider-specific API documentation lives with the `ProviderProfile` variants. The build-only `scripts/docs_theme.py` and `scripts/docs/` assets apply the shared Zeroshot typography and palette, responsive guide navigation, light/dark modes, and code-copy controls. The guides remain readable and navigable without JavaScript; rustdoc retains its own search and item navigation. This is a local static build with no documentation service or runtime website dependency.

`scripts/docs_versions.py` wraps exact source builds with the version selector and a manifest containing source identity, publisher identity, named routes, and a snapshot digest. It composes the complete history into a fresh directory, rejects modified or conflicting release snapshots, preserves existing release bytes on retries, and writes mutable development and stable paths. Static HTML redirects retain existing unversioned links and their query/fragment suffixes. `docs.yml` serializes publication, verifies source ancestry and tag identity, stores the version tree on `gh-pages`, and deploys the complete tree. The workflow runs on main, so the existing Pages environment restriction remains effective. [Documentation versions](versioning.md) defines the URL and recovery contract.

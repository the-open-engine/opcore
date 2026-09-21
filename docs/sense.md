# Dependency Sense

For commands and examples, start with [Getting started](getting-started.md) or the [configuration guide](configuration.md#check-proposed-changes-in-memory). This page describes the evidence and comparison rules.

## Decision

`opcore sense` is a local companion to Verify over the selected repository
source. It answers
five mechanical questions for an agent:

1. Did the current Git overlay introduce a runtime dependency cycle?
2. Did it introduce exact nontrivial source, callable-body, or copied-token-region duplication?
3. Did an explicit module boundary grow beyond a conservative limit?
4. Did a mechanically important module acquire or change a documentation obligation?
5. How did confirmed direct dependencies and reverse impact change?

Runtime-cycle behavior below is one blocking rule. Sense also implements the
introduced-only exact duplication, explicit module-interface, and documentation
ownership rules specified in [Agent signals](agent-signals.md). Raw dependency deltas and
reverse impact remain bounded observations; confirmed counts are not presented
as semantic call-graph evidence.

## Exact State And Worktrees

One stabilized Git capture constructs HEAD once and overlays staged, dirty, deleted, and untracked source paths to produce the after view. Before and after reuse unchanged immutable file values. The path universe is the union needed to preserve staged deletions and additions. When Go source is present, exact relevant root and nested `go.mod` bytes are captured as request-local auxiliary inputs and bound into graph-view identity. Sense revalidates HEAD, index, relevant worktree bytes, and selected module metadata before returning and retries once when the view changes.

`sense --staged` compares selected HEAD dependencies with the exact stage-0 index and ignores unstaged or untracked worktree bytes. Configuration, Go metadata, and referenced documents follow the same view. It revalidates the linked-worktree index and HEAD before returning. `sense --tree <target> --base <base>` compares immutable Git trees, which the CI workflow also uses. Neither mode writes trees, stashes, temporary worktrees, or repository state.

`sense --hypothetical FILE` uses the exact current worktree as its before view and applies a strict bounded write/delete request entirely in memory; `-` reads stdin. Source, selected `go.mod`, and documentation inputs share the overlay. A proposed `.opcore.json` write may change `documentation.bindings` only; all other configuration must remain semantically identical. Duplicate or unsafe paths and unknown fields fail validation, and the request digest binds freshness. Sense revalidates the base worktree after evaluation without writing source or Git state.

`--workflow <name>` selects threshold, coverage, and exclusion overrides without changing those explicit source modes. Literal exclusions narrow the graph before analysis; the report identifies any resulting coverage limits. `run <name>` selects both the workflow settings and its intended source mode. See [Configuration](configuration.md).

Repository storage identity remains the canonical Git common directory, so linked worktrees share immutable content facts. Snapshot identity is content-derived. Worktree paths, branch names, mtimes, cache age, and a last-current pointer never establish freshness.

Only path-independent dependency, interface, callable-fingerprint, and token-region facts are persisted through the existing bounded, self-validating cache. Facts are keyed by content, language mode, parser options, and fact ABI. All four fact families share the existing language parser/token pass; Sense never reparses a file just for policy. Resolved targets, adjacency, SCCs, duplicate groups, observations, documentation ownership, comparisons, committed projections, and dirty views remain request-local and are discarded.

## Dependency Envelope

An edge exists only when one local target is confirmed against the exact view. Resolution never executes or interprets project configuration.

| Family | Confirmed facts | Deliberately not resolved |
|---|---|---|
| Node | Static imports and re-exports; runtime and type-only remain distinct | Bare packages, aliases, dynamic imports, `require`, query/hash suffixes, or multiple extension/index candidates |
| Python | `from .module import name` with an unambiguous `.py`/`.pyi` or package target | Absolute imports, `from . import name`, sys.path, namespace/config ambiguity, or multiple candidates |
| Rust | External `mod` declarations and explicit `crate`/`self`/`super` or uniquely local `use`/`pub use` paths in module trees proven from conventional `src/lib.rs`, `src/main.rs`, or `src/bin/*/main.rs` roots | Cargo-configured roots, cfg/cfg_attr, `#[path]`, macro-generated modules, undeclared files, unresolved aliases, or ambiguous `foo.rs`/`foo/mod.rs` targets |
| Go | Static imports matching an exact package directory inside the deepest enclosing root or nested `go.mod` module; production files aggregate on one package representative and test files remain separate | External modules, `go.work`, local `replace`, vendor/GOPATH context, generated packages, custom/cgo/release/compiler build tags, or malformed module metadata |
| HCL, Shell, Protobuf | No dependency facts; fast syntax and hygiene remain available | Imports/includes/tool-specific loading and generated-code semantics |

Coverage counts recognized `node:` built-in boundaries as a subset of external references while retaining the existing external total; resolved, ambiguous, unresolved, unsupported-loader/dynamic or conditional, parser-failed, configuration-error, and truncated counters remain separate. Opcore uses a pinned, conservative list of public Node built-ins and subpaths rather than trusting the prefix alone, so unknown `node:` names remain ordinary external gaps. Each graph view also returns a deterministic sample of at most five `resolutionGaps` entries containing the path, import specifier, and gap kind; `resolutionGapsTruncated` marks a larger set. Bare Node specifiers, Python absolute imports, `require`, dynamic imports, unsupported Rust project context, external or conditionally selected Go imports, HCL/Shell/Protobuf semantic extraction, and recognized extension-classified unsupported source make the report `partial`; malformed relevant `go.mod` is `incomplete`. None can silently support a globally clean graph claim. `--allow-node-builtins` narrowly acknowledges recognized explicit `node:` boundaries while preserving their evidence; it does not accept unknown `node:` names, bare packages, missing local imports, aliases, or any other partial cause. Rust facts are structural rather than runtime: they inform dependency breadth, reverse impact, and importance but never runtime-cycle findings. Go package imports are runtime edges. Unknown docs/data remain outside the source-candidate envelope. Confirmed cycles remain sound findings under partial coverage.

Dependency facts are bounded per file and in aggregate. Overflow is explicit coverage loss, never silent truncation. Duplicate-analysis limit issues distinguish callable extraction, token-region extraction, request collection, and exact token comparison. Each issue reports its fixed limit, processed count, applicable before/after view, a bounded deterministic path sample, whether that sample was truncated, and an honest next step; no runtime option is presented as raising a compiled safety bound. Topology and report algorithms are iterative, deterministic, and bounded; graph traversals are linear while ordered indexes add logarithmic factors.

## Metric Semantics

### Introduced runtime cycle

Runtime adjacency excludes type-only edges. Before and after strongly connected components are computed independently. An after component is cyclic when it has more than one file or contains a self-edge. It is introduced when its members are not wholly contained in one cyclic before component after applying only one-to-one exact-content path continuity.

One diagnostic is emitted per introduced component. Evidence contains sorted members, the lexicographically first new internal edge, and a deterministic shortest lexicographic return path. Bounded evidence reports the exact component size and `witnessTruncated` rather than presenting a partial path as complete. Existing cyclic debt and changed edges wholly inside the same prior cyclic component do not block.

### Direct dependency delta

For each changed importer, count unique confirmed local targets before and after, split into runtime, type-only, and structural counts. Report the raw values and delta. There is no default dependency budget.

### Reverse impact and high fan-in

Impact is reverse reachability in the after graph for present files and the before graph for deleted files. It reports confirmed direct dependents and confirmed reachable dependents (including direct dependents), plus a bounded, sorted path sample. Counts describe only confirmed edges; coverage states where the resolver deliberately lacks edges. A request-wide traversal bound prevents changed-file count times graph-size behavior; affected counts are explicitly labeled lower bounds and the report becomes `partial`.

Changed files at or above the displayed direct-fan-in threshold are called high-impact changes. The observation suggests reviewing dependents, tests, and documentation as applicable; it does not claim documentation is missing or required.

### Exact duplication

Files are grouped by exact content identity above the documented minimum byte size. Callable bodies are grouped by exact fingerprints of their existing lexer tokens, separated into Node, Python, Rust, and Go domains. The callable declaration name and signature are outside the body fingerprint. Comments and formatting-only whitespace are ignored, while Python indentation/logical-newline tokens, Node inter-token line breaks, and Go semicolon-insertion line boundaries are retained because they can change meaning. Only maximal nonnested callable bodies with at least 48 non-structural tokens participate; nested callable copies do not cascade from an already-reported enclosing body.

Arbitrary copied regions use 32-token rolling k-grams and a 17-k-gram rightmost-minimum winnowing span, which guarantees an anchor for every exact run of at least 48 normalized tokens. Dual rolling hashes nominate candidates only. Compact cached token spans exact-check candidates against immutable source bytes, extend both directions, and merge overlapping anchors into one maximal region. Candidate selection prefers the exact region supported by the most occurrences and then the longest region, so one copied block does not become one finding per anchor. Language domains never cross. If exact token evidence cannot be decoded, Sense returns `incomplete` with `dedup_exact_evidence_malformed` and sets the affected view's `dedupCoverage.*.malformedEvidence`; resource limits remain separate under their stage-specific issues and `requestTruncated`.

Comparison is by after-versus-before occurrence cardinality after one-to-one exact-content path continuity. Existing duplicate debt is clean until another occurrence is introduced; pure exact renames and copy-delete moves do not qualify. An exact whole-file finding suppresses callable and region cascades caused only by that copied file, while a callable finding suppresses an overlapping region cascade. Evidence is one bounded group sample sorted with changed occurrences first, never O(group squared) pairs.

### Explicit module interface

For each changed logical module, Sense compares confirmed dependency targets, explicit selectors on each resolved edge and namespace, authoritative explicit exports, and directly exported TypeScript or Go shape members. Go production files in one package directory aggregate on a deterministic representative; a change to any file projects the package interface. Go imports are namespace-width by language design and therefore do not claim explicit selector-width enforcement. The default limits are 20, 8, 20, and 20 respectively. A finding requires an after value above the limit and above the continuous authoritative before value. Tests and declaration files do not block; pure barrels additionally do not block on public-export breadth.

Interface facts are consumed only for changed-module policy paths, while the full lightweight dependency projection supplies confirmed runtime-plus-structural fan-in. The report carries effective policy, separate interface coverage, and nonzero per-module deltas. Each interface delta states before/after public-surface authority and preserves authoritative export or shape-fingerprint churn even when counts are unchanged. Bounded `importantNodes` observations cover changed or deleted modules with at least 10 confirmed non-type-only importers or more than 20 authoritative exports; they include exact rename continuity, newly-important state, and authoritative public-surface change for documentation enforcement. A changed, important, documentation-bound Python module without authoritative public surfaces in both views produces a binding-specific partial-coverage issue because `sense.documentation.document_not_updated` cannot be evaluated; exact static module-level `__all__` remains the authoritative Python surface.

The default high-impact threshold is 10 confirmed direct dependents and the identical-file minimum is 256 bytes. Callable extraction stops at 4,096 bodies per file and request comparison stops at 200,000 occurrences. Region extraction stops at 4,096 anchors per file; request comparison stops at 200,000 anchors and 4,000,000 exact token comparisons. A truncated region file retains no partial evidence. Cycle members and witnesses, duplicate occurrences, interface selectors, observation samples, finding counts, total observation counts, and serialized JSON are hard-bounded. Any correctness-relevant truncation is an `incomplete` non-success, including under `--advisory`.

## Explicit Exclusions

The MVP has no graph database, SQLite, WAL, watcher, daemon, socket, FTS, temporary repository, persisted topology, persisted overlay, symbol/call/inheritance graph, dead-code inference, PageRank, community detection, embeddings, fuzzy/renamed-identifier/semantic clone search, toolchain execution, compiler-configuration resolver, automatic threshold learning, blended score, or graph ASP capability. Exact token-region identity and explicit module-boundary facts do not widen this boundary.

Topology caching is deferred. Measurements must first prove that exact Git acquisition plus shared content facts miss the request budget; only an immutable correctness-neutral acceleration may then be considered.

## Performance Measurements And Correctness Tests

The untouched release baseline is retained outside implementation measurements. Verify benchmarks record warm one-file, warm ten-file, and 1,000-file parsing fixtures so regressions can be investigated without turning shared-host timings into release failures.

Sense measurements separate Git capture, combined fact loading/extraction, resolution, cycles, observations, exact duplication, rendering, wall time, RSS, unique source bytes analyzed, hits, and misses. They cover cold and warm 1k/10k repositories, no-change and meaningful one-file overlays, 1k dependency-changing files, dense edges, many baseline SCCs, and eight concurrent linked worktrees. The report keeps the 10x vertex/edge comparison visible for investigation without assigning it a pass threshold.

The 10k fixture records cold Sense, clean warm graph computation, a warm one-file overlay, eight simultaneous linked worktrees sharing a warm fact cache, and peak request RSS. It does not compare those values with release thresholds. Acquisition remains separately visible because exact Git stabilization and final freshness validation are correctness work, not graph computation.

Required adversarial cases include type-only/runtime cycles, Rust structural reciprocity, conventional and custom Rust roots, undeclared and ambiguous Rust modules, cfg/path degradation, Go package cycles, root/nested/malformed/module-only `go.mod` changes, build constraints, package aggregation, staged and hypothetical module metadata, re-exports, ambiguous extension/index candidates, Python package/module ambiguity, path escape, parser failure, specifier limits, self-loops, cycles jointly introduced by multiple edges, baseline SCC expansion/split, deleted-file impact, exact rename versus copy, baseline duplicate debt, copy-delete continuity, same-file duplication, whole-file and callable cascade suppression, language-domain separation, exact 48-token offset coverage, forced anchor-hash collisions, repetitive token streams, Node automatic-semicolon-insertion line breaks, Python indentation, large duplicate groups, deterministic output, output truncation, cache corruption and concurrent publication, staged deletion/addition, hypothetical source and documentation writes/deletes, malformed/duplicate/unsafe hypothetical input, sparse checkout, unborn HEAD, concurrent HEAD/index/worktree mutation, and divergent dirty linked worktrees.

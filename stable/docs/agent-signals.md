# Agent Signals

## Decision

Sense adds three bounded, introduced-only intervention families without adding a
symbol graph:

1. exact nontrivial source, callable-body, and copied-token-region duplication;
2. explicit module-boundary breadth;
3. documentation ownership for mechanically important modules.

Language parsers emit only immutable, path-independent facts during their
existing parse. The shared fact cache may persist those facts. Paths, resolved
targets, reverse impact, thresholds, comparisons, findings, documentation
bindings, and dirty views remain request-local. There is no second parser,
project execution, topology cache, mutable graph, database, daemon, or watcher.

## Comparison

Policy compares the same path first. A removed and added path are continuous
only when one-to-one exact-content matching proves a pure rename. An edited move
is new because no stronger identity exists. A finding is introduced only when
the after value exceeds its limit and grew relative to the continuous before
value. Existing debt that is unchanged or reduced does not block.
An unknown or partial baseline public surface never counts as a confirmed
zero-width surface for a newly-important documentation transition.

## Exact Duplication

Whole-file identity uses the source content identity and retains the existing
256-byte minimum. Callable identity hashes the non-trivia tokens of a callable
body or expression, excluding the declaration name, parameters, signature, and
outer body delimiters. Hash domains separate Node, Python, Rust, and Go. Identifiers,
properties, operators, keywords, and literal spellings are not normalized.

Only complete parser output is trusted. Callable groups require at least 48
non-trivia tokens. Extraction retains at most 4,096 callables per file and
request output retains bounded group and occurrence samples. Comparison uses
per-path multiplicities so pure renames, copy-and-delete, and pre-existing
duplicate debt are not fabricated additions. A whole-file duplicate suppresses
the redundant callable groups caused solely by that copied file.

Copied regions use 32-token rolling k-grams and a 17-k-gram rightmost-minimum
winnowing span, guaranteeing an anchor for every exact run of at least 48
normalized tokens. Cached anchors remain path-independent and carry compact
exact token-span evidence. Rolling hashes only nominate candidates; request-local
comparison exact-checks immutable source bytes, extends maximal regions, and
chooses the region shared by the most occurrences before length. Bounds are
4,096 anchors per file, 200,000 per request, and 4,000,000 exact token
comparisons. Truncation emits no partial file facts and makes Sense incomplete.

## Module Interface

The interface projection records only explicit module-boundary syntax:

- Node static import and re-export selectors, explicit exports, and directly
  exported TypeScript interface/type-literal member counts plus bounded,
  whitespace-insensitive shape fingerprints;
- Python selectors on confirmed explicit-relative `from` imports and exact
  static module-level `__all__` values;
- Rust structural dependency targets and fan-in from proven conventional module
  trees; Rust selector widths and public-surface facts remain unsupported.
- Go exact local package imports, package-aggregated exported declarations, and
  directly exported struct/interface member counts and fingerprints; import
  selector width remains unknown because Go imports packages, not symbols.

Runtime, type-only, and structural evidence remain distinct. Namespace, wildcard, CommonJS,
dynamic, recovered, and truncated forms are coverage gaps, never guessed width.
Repeated aliases/selectors are deduplicated by their external boundary name.
Ordinary changed-module observations expose before/after public-surface authority
and authoritative export or shape-fingerprint churn even when every displayed
count remains unchanged. This is advisory evidence, never a new blocker.

Default blocking limits are:

| Metric | Limit |
|---|---:|
| confirmed local dependency targets per module | 20 |
| explicit selectors on one confirmed edge | 8 |
| explicit public exports per module | 20 |
| members in one directly exported TypeScript or Go shape | 20 |

Defaults may be tightened or relaxed within hard safety bounds through root `.opcore.json` and its selected workflow overrides. Reports identify the effective settings and configuration digest. The file also selects literal excluded subpaths; it cannot execute plugins or arbitrary commands.

Go test files and declaration files do not block on module breadth. Pure barrels and
declaration files do not block on public-surface breadth. Their exact evidence
remains observable. A confirmed lower bound above a limit is a sound finding
under partial coverage; truncation makes the report incomplete.

## Documentation Ownership

Documentation ownership is explicit rather than inferred from Markdown prose.
Root `.opcore.json` holds the optional exact bindings in its `documentation` section:

```json
{
  "schemaVersion": 1,
  "documentation": {
    "bindings": [
      { "source": "src/runtime/router.ts", "document": "docs/runtime-router.md" }
    ]
  }
}
```

Paths are exact normalized repository-relative paths. There are no globs,
regular expressions, inheritance rules, plugins, or basename matching. The
configuration is limited to 256 KiB and 4,096 bindings; duplicate sources, unknown
fields, invalid paths, source-to-self bindings, registry-as-document bindings,
unsafe files, and required-read truncation fail closed.

A module is mechanically important when it has at least 10 confirmed direct
non-type-only importers or more than 20 explicit public exports. A binding and existing
document are required when a source-changed module newly becomes important.
Adding an importer does not impose a documentation edit on an otherwise
unmodified target. When an already-important module's explicit export set or
exported TypeScript or Go shape fingerprint changes, the document bound in the after
view must itself differ from its own HEAD bytes. Rebinding to a pre-existing
unchanged document does not satisfy the obligation. Rename and deletion handling
uses the same content continuity and exact binding semantics; stale bindings
never count as documentation.

Configuration follows the selected worktree, index, or committed view. Sense
captures referenced documents from that same view and the selected baseline only
when documentation policy needs them. Final freshness validation covers source,
configuration, and referenced documents. Linked worktrees
share parser facts through their common Git directory, while registry overlays,
document overlays, policy comparison, and findings remain per worktree.

## Release Proof

Release requires focused parser and policy fixtures, malformed/truncated input,
baseline-debt and rename/copy cases, divergent linked worktrees, concurrent
cache publication, deterministic output, output bounds, and dense/10k-file
stress. Verify and Sense record latency, RSS, and scaling measurements for
regression investigation; none of those measurements is a release threshold.
No-trigger documentation policy must perform no referenced-document reads.

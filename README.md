<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/opcore-hero-dark.png">
  <img alt="Opcore" src="docs/brand/opcore-hero-light.png" width="720">
</picture>

<br><br>

**One gate for everything your agent just changed.**

41 checks in a single pass over the changed files, answering with an exit code an agent can branch on. Backed by a Rust code graph, so it reads across files instead of one at a time.

[![license](https://img.shields.io/badge/license-MIT-171411?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2022-171411?style=flat-square)](#install-and-wire-the-gate)
[![platforms](https://img.shields.io/badge/platforms-darwin--arm64%20·%20darwin--x64%20·%20linux--x64-171411?style=flat-square)](#platforms)
[![The Open Engine · Layer 02](https://img.shields.io/badge/The_Open_Engine-Layer_02-C2240C?style=flat-square&labelColor=171411)](#the-open-engine)

</div>

```text
$ opcore check --changed

  BLOCKED   exit 1

  WARN  typescript.dead-code       src/domain/money.ts
        Exported symbol has no incoming CALLS graph evidence: orphanedHelper
  WARN  typescript.relevant-tests  src/domain/cart.ts
        No TESTED_BY graph evidence found for src/domain/cart.ts
  FAIL  typescript.types           src/domain/money.ts:24   TS2322
        Type 'number' is not assignable to type 'string'.
```

A function nobody calls anymore and a module no test touches, neither of which a per-file linter can see. The type error underneath them is what stops the edit.

## Only what the edit broke

Changed-file runs report introduced findings. A type error that was already sitting in a file you touched does not block you; the one your edit just added does.

That distinction is why the gate is usable in a repo with existing debt. Running the whole toolchain over a changed file and diffing the noise yourself is the alternative, and it is why most pre-commit setups end up disabled.

| Exit | Meaning |
| ---: | --- |
| `0` | Within tolerance. No findings. |
| `1` | Findings present, or an error the caller should handle. |
| `2` | Requested check is not implemented for this stack. |
| `64` | Unsupported scope. Counted, not failed. |

## What it catches

41 checks, grouped by the kind of decay they find. 25 run in the default changed-file gate; the other 16 you turn on.

**Structure.** Exports and files with no incoming edges, import cycles, and orphan modules. `dead-code`, `import-graph`, `import-layer-rules`, and on Rust `graph-signals`.

**Untested surface.** Symbols and modules with no test reaching them, resolved through the graph rather than a coverage percentage. `relevant-tests`.

**Duplication.** Near-duplicate code across the repo, detected in the Rust core. `clone.duplication`.

**Size and complexity.** Files and functions that outgrew themselves, with configurable thresholds. `file-length`, `function-metrics`.

**Documentation.** Docs that went stale, went missing, or drifted from the code they describe. `docs.existence`, `docs.staleness`, `docs.freshness`, `docs.dry`, `docs.length`, `docs.hub-coverage`, `docs.subtree-coverage`, `docs.code-blocks`, `docs.content-quality`, `docs.rules-why`. All opt-in; enable them in `.opcore/config`.

**Correctness.** The compiler and toolchain, wired to the same exit code so one gate is enough. `syntax`, `types`, `lint`, `lint-plugin`, on Rust `fmt`, `cargo-check`, `clippy`, `rustdoc`, `unused-deps`, and on Python `ruff-lint`, `ruff-format`, `pytest`.

Every finding names a file, a check ID, and a symbol.

| Stack | Checks | Maturity |
| --- | ---: | --- |
| TypeScript, JavaScript | 10 | graph-backed |
| Rust | 11 | graph-backed |
| Python (`.py`, `.pyi`) | 9 | experimental |
| Documentation, any repo | 10 | opt-in |
| Duplication, any repo | 1 | |

Files in other languages are counted and reported as unsupported.

## Install and wire the gate

```bash
npx opcore install
```

It scans first, prints the plan, and asks before writing anything. Inside a Git repo it offers the Claude Code and Codex write gate for that repo or globally. The default repo setup installs the Opcore agent skill, the write-gate hooks, and a Git pre-commit hook running `opcore check --changed` when no pre-commit hook already exists.

For a binary that stays on `PATH`:

```bash
npm install -g opcore
opcore install --global
```

Everything it writes is additive and recorded in `.opcore/init-undo.json`, and `opcore uninstall --yes` removes it. `--json` and non-TTY runs stay plan-only unless you pass `--yes`.

Requires Node 22 or newer.

## Commands

```bash
opcore --repo .                 # read-only scan: coverage, then findings
opcore status                   # readiness and coverage; never writes
opcore graph build --repo .     # build the graph before graph-backed checks
opcore check --changed --json   # the agent gate; also --staged or explicit <files>
opcore install                  # scan, then wire repo/global hooks after approval
opcore uninstall --yes          # remove only what Opcore added
opcore measure --repo .         # before/after deltas from local history
opcore try                      # run the loop on generated sample repos
```

## How it works

Opcore is hybrid: a Rust graph core owns extraction, persistence, and the hot queries, while TypeScript owns the contracts, the CLI, and the validation adapters.

The graph records five edge kinds: `CALLS`, `IMPORTS_FROM`, `INHERITS`, `IMPLEMENTS`, and `TESTED_BY`. Structural findings are read off those edges, so a dead export means nothing points at it, not that a search failed to match.

Graph-backed checks need a current graph. Build it once with `opcore graph build`; the gate refreshes incrementally after that.

For the ownership model, see @docs/architecture/runtime-cli-ard.md.

## Known limits

Graph-backed checks stay quiet until the graph exists. A fresh repo reports nothing structural until `opcore graph build` runs.

Documentation checks ship with no default scope, so none of the ten fire until you enable them.

Reachability walks `CALLS`, `INHERITS`, and `IMPLEMENTS`. A function passed as a value rather than called, as in `items.map(lineTotal)`, records no edge and can be reported as a dead export. Tracked in [#299](https://github.com/the-open-engine/opcore/issues/299).

Public APIs whose callers live outside the repo need declaring, through `package.json` `exports` or `validation.checks.typescript.deadCode.entrypoints`.

Python is experimental, and three of its nine checks are opt-in. `python.types` needs one configured mypy or Pyright per project and reports absent or conflicting authority as degraded rather than guessing; `python.ruff-lint`, `python.ruff-format`, and `python.pytest` stay off until enabled.

## Platforms

`darwin-arm64`, `darwin-x64`, and `linux-x64`. Unsupported platforms return typed degraded status instead of crashing. Windows is not supported.

## Docs

[Quickstart](docs/quickstart.md) · [Concepts](docs/concepts.md) · [Examples](docs/examples.md) · [Agent integration](docs/agent-integration.md) · [Architecture](docs/architecture/runtime-cli-ard.md)

## The Open Engine

Opcore is Layer 02 (Constraints) of [The Open Engine](https://theopenengine.com), sibling to [Zeroshot](https://github.com/the-open-engine/zeroshot) (Layer 01, Verification).

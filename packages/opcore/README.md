# Opcore

**One gate for everything your agent just changed.**

41 checks in a single pass over the changed files, answering with an exit code an agent can branch on. Backed by a Rust code graph, so it reads across files instead of one at a time.

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

The first two are things a per-file linter cannot see. The type error is what stops the edit.

## Only what the edit broke

Changed-file runs report introduced findings. A type error already sitting in a file you touched does not block you; the one your edit just added does. That is what makes the gate usable in a repo that already has debt.

| Exit | Meaning |
| ---: | --- |
| `0` | Within tolerance. No findings. |
| `1` | Findings present, or an error the caller should handle. |
| `2` | Requested check is not implemented for this stack. |
| `64` | Unsupported scope. Counted, not failed. |

## Install

```bash
npx opcore install
```

It scans first, prints the plan, and asks before writing anything. Inside a Git repo it offers the Claude Code and Codex write gate for that repo or globally.

For a binary that stays on `PATH`:

```bash
npm install -g opcore
opcore install --global
```

If `opcore` is missing after a global install, put npm's global bin directory on `PATH`:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Requires Node 22 or newer. Installing the package writes nothing; setup happens only when you run `opcore install` and approve the plan. `--json` and non-TTY runs stay plan-only unless you pass `--yes`.

Approved repo setup writes `.opcore/config`, one delimited guidance block, the agent skill files, a repo-local write-gate adapter, merged Claude Code and Codex hook entries, a managed `.opcore/` line in `.gitignore`, a Git pre-commit hook when no other one exists, and `.opcore/init-undo.json`. Undo it with `opcore uninstall --yes`.

## The agent gate

After `opcore install`, supported Claude Code and Codex write calls run the pre-write gate before the write lands. You can also run it by hand:

```bash
opcore check --changed --json
```

Output is stable JSON with the exit codes above. It works in a freshly `git init` repo with no commits, treating the empty baseline as the comparison base. Codex coverage follows its current hook interception boundary.

## What it catches

41 checks. 25 run in the default changed-file gate; the other 16 you turn on.

- **Structure** — exports and files with no incoming edges, import cycles, and orphan modules.
- **Untested surface** — symbols and modules no test reaches, resolved through the graph rather than a coverage percentage.
- **Duplication** — near-duplicate code across the repo.
- **Size and complexity** — files and functions past configurable thresholds.
- **Documentation** — docs that went stale, went missing, or drifted from the code they describe. Ten checks, all opt-in.
- **Correctness** — syntax, types, and lint, plus the Rust and Python toolchains, wired to the same exit code.

| Stack | Checks | Maturity |
| --- | ---: | --- |
| TypeScript, JavaScript | 10 | graph-backed |
| Rust | 11 | graph-backed |
| Python (`.py`, `.pyi`) | 9 | experimental |
| Documentation, any repo | 10 | opt-in |
| Duplication, any repo | 1 | |

Files in other languages are counted and reported as unsupported.

Graph-backed checks need a current graph. Build it once with `opcore graph build`; the gate refreshes incrementally after that.

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

`opcore measure` reads existing metric artifacts and reports named deltas. `opcore` writes `.opcore/report.json`, `.opcore/history.jsonl`, and a bounded `.opcore/telemetry.jsonl`.

## Platforms

`darwin-arm64`, `darwin-x64`, and `linux-x64`, on Node 22 or newer. Unsupported platforms return typed degraded status instead of crashing. Windows is not supported.

## ASP provider

The `opcore` package exposes both `opcore` and `opcore-asp-provider` as bins, so there is no separate install. Provider output is input for an ASP host to evaluate; the host decides policy and applies changes. Private hosts launch it with `opcore-asp-provider --stdio`.

## Docs

[Quickstart](https://github.com/the-open-engine/opcore/blob/main/docs/quickstart.md) · [Concepts](https://github.com/the-open-engine/opcore/blob/main/docs/concepts.md) · [Agent integration](https://github.com/the-open-engine/opcore/blob/main/docs/agent-integration.md) · [Examples](https://github.com/the-open-engine/opcore/blob/main/docs/examples.md)

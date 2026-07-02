# Quickstart

## Install

```bash
npx @the-open-engine/opcore init         # repo setup with a plan and approval prompt
npm install -g @the-open-engine/opcore   # global CLI, then run opcore init --global
```

Install scripts do not modify repos or agent settings. The package only prints a setup reminder. Requires Node >=22. Supported platforms are `darwin-arm64`, `darwin-x64`, and `linux-x64`. Unsupported platforms return typed degraded status instead of crashing.

If `opcore` is not found after a global install, check npm's global prefix and put its `bin` directory on `PATH`:

```bash
npm prefix -g
export PATH="$(npm prefix -g)/bin:$PATH"
```

## First Run

Run this inside the repository you want to inspect:

```bash
opcore
opcore --version --json
opcore doctor --repo . --json
opcore --repo .
opcore status
```

- The read-only scan prints Coverage before Findings, reports concrete counts and locations, and writes only `.opcore/report.json`, `.opcore/history.jsonl`, and bounded `.opcore/telemetry.jsonl`.
- `--version --json` reports the exact package version, package root, and entrypoint.
- Scan, status, check, and measure are read-only for source files.

Use JSON when another tool consumes the result:

```bash
opcore --json
opcore status --json
opcore doctor --json
```

## The Gate

Check changed files from agents or hooks:

```bash
opcore check --changed --json
opcore check --staged --json
opcore check --changed --checks python.syntax,python.source-hygiene --json
```

Agents should treat any non-zero exit as a blocked write unless their workflow has a typed recovery path.

`opcore check --changed --json` works in a freshly `git init` repo with no commits; it treats the empty baseline as the comparison base.

## Measure

```bash
opcore measure
opcore measure --repo .
```

`opcore measure` compares the latest scan with the baseline or previous scan and reports concrete deltas such as type errors, untested surface, dead exports, Python syntax/source-hygiene or optional type-tool degradation, suppression abuse, oversized files, and unsupported-language coverage.

## Setup

Wire the write gate after reviewing the plan:

```bash
opcore init
opcore init --global
opcore init --repo . --approve
```

`opcore init` runs the read-only scan first. When the scan completes, it prints coverage before findings, shows the additive setup plan, and prompts on a TTY. In a Git repo, it asks whether to install the Claude Code/Codex write gate for this repo or globally. `opcore init --json` previews without writing, and non-TTY runs stay plan-only unless `--approve` is passed.

Approved repo init writes additive `.opcore/config`, one delimited guidance block, a repo-local write-gate adapter, merged Claude Code/Codex hook entries, a managed `.opcore/` line in `.gitignore` for Git repos, and `.opcore/init-undo.json`. Approved global init writes user-level hook config plus `~/.opcore/init-undo.json`. Undo recorded setup with `opcore init --undo --approve` or `opcore init --global --undo --approve`.

## Coverage

Opcore is deep for TypeScript/JavaScript graph-backed signals and useful for Rust validation signals. Python is experimental and degraded-honest: `.py`/`.pyi` graph-backed structure, untested modules, dead exports, syntax, and source-hygiene are reported when available; `python.types` depends on mypy or pyright and reports missing tools as degraded. Other non-TS/JS/Rust/Python languages are counted and reported as unsupported; they do not get fake findings or fake ratings.

## Demo Loop

```bash
opcore try
```

`opcore try` generates local TS, Rust, mixed, and unsupported-file samples, then runs scan, init, check, and measure without publishing anything.

## Private ASP Provider Mode

Private ASP hosts may launch the provider process behind host-owned decisions and receipts:

```bash
opcore-asp-provider --stdio
```

The aggregate `@the-open-engine/opcore` package exposes only the `opcore` bin; `opcore-asp-provider` comes from the separate `@the-open-engine/opcore-asp-provider` package.

Do not treat provider output as a gate decision. The provider returns ASP Assessments; the ASP host returns allow, deny, or indeterminate decisions plus receipts.

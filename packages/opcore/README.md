# Opcore

Deterministic local changed-file validation gate for coding agents.

Opcore gives coding agents and maintainers a read-only-first repo check loop: scan the current repo, report coverage honestly, run changed-file validation, and track concrete local metric deltas. It is built for local feedback before review, not for remote publishing or opaque ratings.

## First Run

```bash
npx @the-open-engine/opcore@0.1.0-alpha.0 init
```

The one-command path starts the interactive onboarding wizard without a prior install. It runs a read-only scan first, prints Coverage before Findings, reports concrete counts and locations, shows the additive setup plan, and asks before writing anything.

Scan/status/check/measure are read-only for source files. The scan loop writes only `.opcore/report.json`, `.opcore/history.jsonl`, and bounded `.opcore/telemetry.jsonl`. Approved init writes only additive `.opcore/config`, one delimited guidance block in an existing agent file or new `AGENTS.md`, a managed `.opcore/` line in `.gitignore` for Git repos, and `.opcore/init-undo.json`. Undo recorded setup with `opcore init --undo`.

## Changed-File Agent Gate

Use the changed-file gate before handing edits to a reviewer or merge process:

```bash
opcore check --changed --json
```

The command validates changed source files with stable JSON and agent-friendly exit codes. It is local, deterministic for current worktree inputs, and does not publish, install packages, set up ASP, set up ACE, run wrapper tools, or edit source files.

`opcore check --changed --json` works in a freshly `git init` repo with no commits; it treats the empty baseline as the comparison base.

## Coverage Honesty

- TypeScript and JavaScript: deep graph-backed and validation signals for syntax, types, imports, relevant tests, dead exports, and graph structure when facts are available.
- Rust: validation and toolchain signals only unless a later accepted issue expands graph extraction or product coverage.
- Other languages: counted and reported as unsupported; Opcore does not invent findings or ratings for files it cannot assess.

Metric output is named evidence and deltas, not a blended quality number.

## Command Reference

```bash
opcore
opcore --repo .
opcore status
opcore init
opcore init --repo . --approve
opcore check --changed --json
opcore check --staged --json
opcore measure
opcore measure --repo .
opcore try
```

- `opcore` scans read-only, prints Coverage before Findings, and writes only `.opcore/report.json`, `.opcore/history.jsonl`, and bounded `.opcore/telemetry.jsonl`.
- `opcore status` reports activation readiness without running scans, installs, setup, checks, wrappers, or writes.
- `opcore init` is scan-first and ask-before-write on a TTY; JSON preview runs stay plan-only unless approved.
- `opcore check --changed --json` and `opcore check --staged --json` are agent gates for source changes.
- `opcore measure` reads existing metric artifacts and reports named deltas, not a blended rating.
- `opcore try` creates local sample repos and runs the demo loop without publishing anything.

## Repeat Use

Install globally when you expect to run Opcore repeatedly:

```bash
npm install -g @the-open-engine/opcore@0.1.0-alpha.0
opcore
opcore init
```

If `opcore` is not found after a global install, check npm's global prefix and put its `bin` directory on `PATH`:

```bash
npm prefix -g
export PATH="$(npm prefix -g)/bin:$PATH"
```

Restart the shell or add that export to the shell startup file used by the environment.

## Platform Support

Alpha package artifacts target `darwin-arm64`, `darwin-x64`, and `linux-x64` with Node >=22. Unsupported platforms return typed degraded status instead of crashing. Windows is out of scope for `0.1.0-alpha.0`.

## Advanced ASP Provider Note

**Providers assess; ASP hosts decide.** `opcore-asp-provider --stdio` can return Opcore validation assessments to an ASP host. Provider output is evidence for the host to evaluate, not authority to decide policy, enforce gates, or apply changes.

## Docs

- [Quickstart](https://github.com/the-open-engine/opcore/blob/main/docs/quickstart.md)
- [Concepts](https://github.com/the-open-engine/opcore/blob/main/docs/concepts.md)
- [Agent integration](https://github.com/the-open-engine/opcore/blob/main/docs/agent-integration.md)
- [Examples](https://github.com/the-open-engine/opcore/blob/main/docs/examples.md)
- [Demo](https://github.com/the-open-engine/opcore/blob/main/docs/demo.md)

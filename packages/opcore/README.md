# @the-open-engine/opcore

Status: maintainer-controlled alpha staging. Do not publish or announce without maintainer approval.

Opcore is the npm package for local repository scans, coverage honesty, setup guidance, and changed-file validation for coding agents.

## First Run

```bash
npx @the-open-engine/opcore@0.1.0-alpha.0 init
```

The one-command path starts the interactive onboarding wizard without a prior install. It runs a read-only scan first, prints Coverage before Findings, shows the additive setup plan, and asks before writing guidance, config, hooks, or ignore entries.

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

## Command Surface

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

- `opcore` scans read-only, prints Coverage before Findings, and writes only `.opcore/report.json` plus `.opcore/history.jsonl`.
- `opcore status` reports activation readiness without running scans, installs, setup, checks, wrappers, or writes.
- `opcore init` is scan-first and ask-before-write on a TTY; JSON preview runs stay plan-only unless approved.
- `opcore check --changed --json` and `opcore check --staged --json` are agent gates for source changes.
- `opcore measure` reads existing metric artifacts and reports named deltas, not a score.
- `opcore try` creates local sample repos and runs the demo loop without publishing anything.

`opcore check --changed --json` works in a freshly `git init` repo with no commits; it treats the empty baseline as the comparison base.

## Platform Support

Alpha package artifacts target `darwin-arm64`, `darwin-x64`, and `linux-x64` with Node >=22. Unsupported platforms return typed degraded status instead of crashing. Windows is out of scope for `0.1.0-alpha.0`.

## Coverage Honesty

Opcore alpha is deep for TypeScript and JavaScript graph-backed signals and useful for Rust validation signals. Other languages are counted and reported as unsupported in v0; they do not get fake findings or fake scores.

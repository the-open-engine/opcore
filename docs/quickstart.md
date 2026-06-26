# Quickstart

```bash
npx @the-open-engine/opcore@0.1.0-alpha.0 init
```

What this shows:

- `npx @the-open-engine/opcore@0.1.0-alpha.0 init` starts the interactive onboarding wizard without a prior install.
- The wizard runs a read-only scan first, prints Coverage before Findings, and asks before writing.
- Approved init writes only additive `.opcore/config`, delimited agent guidance, undo metadata, a managed `.opcore/` `.gitignore` line in Git repos, and opt-in hooks when requested.

Alpha support is `darwin-arm64`, `darwin-x64`, and `linux-x64` with Node >=22. Unsupported platforms return typed degraded status instead of crashing. Windows is out of scope for `0.1.0-alpha.0`. Unsupported-language files are counted in coverage; day-one checks skip them.

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

## First Scan

Run this inside the repository you want to inspect:

```bash
opcore
opcore --repo .
opcore status
```

Use JSON when another tool consumes the result:

```bash
opcore --json
opcore status --json
```

## Check Changes

```bash
opcore check --changed --json
opcore check --staged --json
```

Agents should treat any non-zero exit as a blocked write unless their workflow has a typed recovery path.

`opcore check --changed --json` works in a freshly `git init` repo with no commits; it treats the empty baseline as the comparison base.

## Measure Progress

```bash
opcore measure
opcore measure --repo .
```

`opcore measure` compares the latest scan with the baseline or previous scan and reports concrete deltas such as type errors, untested surface, dead exports, suppression abuse, oversized files, and unsupported-language coverage.

## Set Up Agent Guidance

```bash
opcore init
opcore init --approve
opcore init --repo . --approve
```

`opcore init` runs the read-only scan first, prints coverage before findings, shows the additive setup plan, and prompts on a TTY. `opcore init --json` previews without writing. Approved init may add `.opcore/config`, delimited agent guidance, mirrors for existing agent files, undo metadata, a managed `.opcore/` `.gitignore` line in Git repos, and optional hooks only when explicitly requested. Non-Git repos skip `.gitignore`; undo removes only the managed line. JSON output includes scan, language settings, interaction, and timing fields.

## Coverage Honesty

Opcore alpha is deep for TypeScript/JavaScript graph-backed signals and useful for Rust validation signals. Other languages are counted and reported as unsupported in v0; they do not get fake findings or fake scores.

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

Do not treat provider output as a gate decision. The provider returns ASP Assessments; the ASP host returns allow, deny, or indeterminate decisions plus receipts.

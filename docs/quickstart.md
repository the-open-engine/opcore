# Quickstart

```bash
npm install -g @the-open-engine/opcore@0.1.0-alpha.0
opcore try
opcore --repo .
opcore init --repo . --approve
opcore check --changed --json
opcore measure --repo .
```

What this shows:

- `opcore try` generates local TS, Rust, mixed, and unsupported-file samples, then runs the loop without publishing anything.
- `opcore --repo .` scans read-only, prints Coverage before Findings, and writes `.opcore/report.json` plus `.opcore/history.jsonl`.
- `opcore init --approve` writes additive `.opcore/config` and delimited agent guidance; hooks stay opt-in.
- `opcore check --changed --json` validates changed files and defaults to `--base HEAD`.
- `opcore measure` reads metric artifacts and prints named deltas, not a score.

Alpha support is `darwin-arm64`, `darwin-x64`, and `linux-x64` with Node >=22. Windows and unsupported-language files are counted in coverage; day-one checks skip them.

## First Scan

Run this inside the repository you want to inspect:

```bash
opcore
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

## Measure Progress

```bash
opcore measure
```

`opcore measure` compares the latest scan with the baseline or previous scan and reports concrete deltas such as type errors, untested surface, dead exports, suppression abuse, oversized files, and unsupported-language coverage.

## Set Up Agent Guidance

```bash
opcore init
opcore init --approve
```

`opcore init` runs the read-only scan first, prints coverage before findings, shows the additive setup plan, and prompts on a TTY. `opcore init --json` previews without writing. Approved init may add `.opcore/config`, delimited agent guidance, mirrors for existing agent files, undo metadata, and optional hooks only when explicitly requested. JSON output includes scan, language settings, interaction, and timing fields.

## Coverage Honesty

Opcore alpha is deep for TypeScript/JavaScript graph-backed signals and useful for Rust validation signals. Other languages are counted and reported as unsupported in v0; they do not get fake findings or fake scores.

## Private ASP Provider Mode

Private ASP hosts may launch the provider process behind host-owned decisions and receipts:

```bash
opcore-asp-provider --stdio
```

Do not treat provider output as a gate decision. The provider returns ASP Assessments; the ASP host returns allow, deny, or indeterminate decisions plus receipts.

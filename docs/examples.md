# Examples

## First Run

```bash
node packages/opcore/dist/index.js init --repo /path/to/repo
```

Expected shape:

```text
Coverage:
  files=... validation=... unsupported=...
Findings:
  <named finding>: count=... locations=...
Setup:
  approval=pending
  writes=.opcore/config, agent guidance block, .gitignore line, .opcore/init-undo.json
```

## Try The Loop

```bash
opcore try
```

Expected shape:

```text
Coverage:
  scenarios=5 files=13 validation=9 unsupported=1
Findings:
  coverage.unsupported_stacks: count=1 delta=0
  python.source_hygiene: count=1 delta=0
  python.syntax_errors: count=1 delta=0
  rust.source_hygiene: count=8 delta=0
  typescript.type_errors: count=2 delta=0
Loop:
  opcore --repo <sample>
  opcore init --repo <sample> --approve
  opcore check --changed --checks typescript.syntax,typescript.types,rust.source-hygiene,rust.file-length,python.syntax,python.source-hygiene --json
  opcore measure --repo <sample>
Sandbox:
  <local temp directory>
  generated locally; published=false
```

## Scan A Repo

```bash
opcore --repo .
```

Expected shape:

```text
Coverage:
  files=... graph=... validation=... unsupported=...
Findings:
  diagnostics=... status=...
```

Use JSON for agents:

```bash
opcore --repo . --json
```

## Add Guidance

```bash
opcore init --repo . --json
opcore init --repo . --approve --json
```

The first command returns a plan. The approved command writes additive setup and undo metadata.
Approved setup writes only `.opcore/config`, one delimited guidance block in an
existing agent file or new `AGENTS.md`, a managed `.opcore/` line in
`.gitignore` for Git repos, and `.opcore/init-undo.json`.

## Gate Changed Files

```bash
opcore check --changed --json
```

The command defaults to `--base HEAD`; pass `--base origin/main` when the workflow needs a different comparison point.

For Python-only validation in the same scan, check, measure loop:

```bash
opcore check --changed --checks python.syntax,python.source-hygiene --json
```

`python.types` is configured-authority evidence. Configured mypy runs per project; configured Pyright is deferred until #257; absent, conflicting, or unavailable authority is degraded instead of inventing a finding.

## Read Deltas

```bash
opcore measure --repo .
```

Expected shape:

```text
Coverage:
  files=... graph=... validation=... unsupported=...
Signals:
  typescript.type_errors: 2 baseline=-1 previous=+0
  python-measure-delta: python.dead-code previous=-1 baseline=+0
  python.types: degraded requiredTool=configured-authority
```

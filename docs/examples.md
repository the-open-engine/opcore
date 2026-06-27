# Examples

## First Run

```bash
npx @the-open-engine/opcore@0.1.0-alpha.0 init
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
  scenarios=4 files=... validation=... unsupported=...
Findings:
  coverage.unsupported_stacks: count=...
  rust.source_hygiene: count=...
  typescript.type_errors: count=...
Loop:
  opcore --repo <sample>
  opcore init --repo <sample> --approve
  opcore check --changed --checks typescript.syntax,typescript.types,rust.source-hygiene,rust.file-length --json
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
```

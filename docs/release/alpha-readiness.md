# Opcore Alpha Readiness

This is the private release checklist for the new Opcore repo. It is not a
public announcement and does not authorize publishing.

## Must Be True Before Alpha

- `opcore` installs and runs from this repo's packaged artifacts.
- `opcore try` works without touching the user's repository.
- `opcore --repo .` runs a read-only scan and writes only
  `.opcore/report.json` plus `.opcore/history.jsonl`.
- `opcore status --repo . --json` is read-only and does not build graphs, run
  checks, install packages, call wrappers, or write files.
- `opcore check --changed --json` has stable agent exit codes.
- `opcore measure --repo .` reports named deltas, not a score.
- `opcore init --repo . --json` previews without writing.
- `opcore init --repo . --approve` is additive, idempotent, reversible, and
  symlink-safe.
- Public docs show coverage before findings.
- Public docs state supported alpha platforms and language boundaries.
- Public docs do not mention legacy product names or old guardrail tools.
- Public docs do not claim public ASP standard status, SAST/security coverage,
  AI authorship detection, autonomous fixing, all-stack support, every-agent
  native support, or replacement of existing guardrails.

## Required Verification

Run from the new repo after the full monorepo export lands:

```bash
npm ci
npm run build
npm test
npm run pack:check
npm run release:hygiene
npm run provenance:check
npm run cutover:check
npm run release:dry-run
```

Installed-artifact smoke must prove:

```bash
opcore try --json
opcore --repo . --json
opcore status --repo . --json
opcore check --changed --json
opcore init --repo . --json
opcore measure --repo . --json
```

Publication remains blocked until maintainers explicitly approve it.

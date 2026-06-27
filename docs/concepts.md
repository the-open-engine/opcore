# Concepts

## Coverage

Opcore starts by counting the repository. TypeScript, JavaScript, Rust sources, `Cargo.toml`, and retained Rust metadata are recognized for alpha checks. Unsupported extensions are still counted with examples so reports do not imply broader coverage than exists.

## Findings

Findings are named signals such as `typescript.type_errors`, `rust.source_hygiene`, and `coverage.unsupported_stacks`. Counts come from validation diagnostics, graph evidence when available, and repository census data. Opcore does not blend them into a single rating.

## Artifacts

Allowed scan artifacts:

```text
.opcore/report.json
.opcore/history.jsonl
.opcore/telemetry.jsonl
```

Telemetry is bounded command latency evidence capped at 500 records or 1 MiB.
Scan/status/check/measure are read-only for source files. `opcore measure`
reads the report and history artifacts and reports baseline/previous deltas. It
does not run checks, build graph data, install packages, or edit source.

## Init

`opcore init` is approval-gated. Without `--approve`, it returns a plan. With
`--approve`, it writes only additive `.opcore/config`, one delimited guidance
block in an existing agent file or new `AGENTS.md`, a managed `.opcore/` line in
`.gitignore` for Git repos, and `.opcore/init-undo.json`.

Undo with `opcore init --undo`; it removes only recorded setup artifacts where
supported.

## Private Provider Mode

For private ASP-hosted dogfood, Opcore can run as the check provider behind a host. The host owns workspace grants, decisions, and receipts; Opcore returns provider assessments and degraded coverage when graph or tool surfaces are unavailable.

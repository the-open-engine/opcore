# Agent Integration

Opcore is a local CLI surface for agents that can run shell commands and consume JSON.

## Readiness

```bash
opcore status --repo . --json
```

`repoState` includes Git counts, language coverage, graph state, validation availability, degraded Rust tools, warnings, blockers, and next actions. Status is read-only: it does not build graph data, run checks, install packages, or write files.

## Setup Guidance

```bash
opcore init --repo . --json
opcore init --repo . --approve --json
```

Preview first. Approved init writes additive config and one delimited guidance block. It preserves existing repo lint, test, CI, pre-commit, and agent guardrails. Undo with:

```bash
opcore init --repo . --undo --approve --json
```

## Validation Gate

```bash
opcore check --changed --json
```

Treat non-zero exits as blocked unless the calling workflow has a typed recovery path.

| Status | Exit |
|---|---:|
| `ok` | 0 |
| `error` | 1 |
| `not_implemented` | 2 |
| `unsupported` | 64 |

## Metrics

```bash
opcore --repo . --json
opcore measure --repo . --json
```

The scan writes metric artifacts. Measure reads those artifacts and returns named signal counts and deltas without re-running validation.

## Private Provider Mode

Private ASP-hosted dogfood can launch Opcore as a provider behind the host. Use that path only when the caller needs host-owned decisions, receipts, workspace grants, or multi-provider aggregation. Direct Opcore output remains CLI evidence and does not become a host decision.

# Agent Integration

Opcore is a local CLI surface for agents that can run shell commands and consume JSON.

## One-Paste Setup

Paste this to any coding agent that runs shell commands (Claude Code, Cursor, Codex, Copilot). It installs Opcore, runs the approval-gated setup, and adopts the gate:

> Set up Opcore in this repo: run `npx @the-open-engine/opcore init`, show me the plan it prints, and approve it if it only adds Opcore config, agent guidance, and Claude Code/Codex write-gate wiring. From then on, treat Opcore hook feedback or a non-zero `opcore check --changed --json` exit as a blocked write.

`opcore init` stays read-only until you approve its plan, preserves existing lint, test, CI, pre-commit, and agent guardrails, and never runs setup from npm install.

After `npm install -g @the-open-engine/opcore` or `npx @the-open-engine/opcore`, the package prints a setup reminder only. Run one of:

```bash
opcore init
opcore init --global
```

## Readiness

```bash
opcore status --repo . --json
```

`repoState` includes Git counts, language coverage, graph state, validation availability, degraded Rust tools, warnings, blockers, and next actions. Status is read-only: it does not build graph data, run checks, install packages, or write files.

## Setup Guidance

```bash
opcore init --repo . --json
opcore init --repo . --local --approve --json
opcore init --global --approve --json
```

Preview first. In a Git repo on a TTY, `opcore init` asks whether to install the write gate for this repo or globally. `--local` forces repo scope, and `--global` writes user-level harness settings. Approved repo init writes additive config, one delimited guidance block, a repo-local write-gate adapter, and additive Claude Code/Codex hook entries. Approved global init writes the adapter under `~/.opcore/hooks/` and merges user-level Claude Code/Codex hook settings.

Undo with:

```bash
opcore init --repo . --local --undo --approve --json
opcore init --global --undo --approve --json
```

Undo restores or removes only paths recorded by Opcore init metadata. Repo metadata lives at `.opcore/init-undo.json`; global metadata lives at `~/.opcore/init-undo.json`.

## Write-Time Harness Gate

`opcore init` installs a small adapter script that reads the harness hook payload on stdin, maps file writes and edits into a hypothetical `ValidationRequest`, and calls:

```bash
opcore validate pre-write --request-file <json> --timeout-ms 30000 --json
```

Claude Code is wired through `hooks.PreToolUse` for `Edit|MultiEdit|Write`; a non-ok `PreWriteValidationReceipt` exits 2 with stderr feedback so Claude Code blocks the tool call before the write lands.

Codex is wired through `PreToolUse` for `apply_patch|Edit|Write`. Current Codex hook behavior supports blocking supported tool calls with exit 2, and `apply_patch` also matches the `Edit` and `Write` aliases. Codex hook trust and complete interception scope remain Codex behavior, so treat this as the strongest available Codex guardrail rather than a claim that Opcore controls every possible write path.

The adapter fail policy is deliberate: payload parse or mapping errors fail open with a stderr note so hook drift does not brick the agent; validation command failures and non-ok receipts fail closed.

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

Repos can extend validation with repo-owned check packs configured in `.opcore/config`:

```json
{
  "checks": {
    "packs": ["./checks/opcore-checks.cjs", "@acme/opcore-checks"]
  }
}
```

Each pack exports `{ id, version?, checks }`, where `checks` are Opcore `ValidationCheckDefinition` objects. Pack specifiers resolve from the target repo root, so `opcore check --repo <path>` uses that repo's configured policies.

## Metrics

```bash
opcore --repo . --json
opcore measure --repo . --json
```

A successful scan writes metric artifacts. Measure reads those artifacts and
returns named signal counts and deltas without re-running validation.

## Private Provider Mode

Private ASP-hosted dogfood can launch Opcore as a provider behind the host. Use that path only when the caller needs host-owned decisions, receipts, workspace grants, or multi-provider aggregation. Direct Opcore output remains CLI evidence and does not become a host decision.

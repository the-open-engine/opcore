---
title: Opcore alpha roadmap
status: active
normative: false
updated: 2026-06-27
summary: Product-first launch plan for the Opcore robustness loop, with ASP kept as a private optional manager/provider seam.
---

# Opcore Alpha Roadmap

## Decision

Ship the first robustness product loop as **Opcore**. Do not launch ASP as a public standard for this alpha.

The public/user-facing path is:

1. `opcore try` runs the loop on generated local sample repositories without publishing anything.
2. `opcore` runs a read-only scan in an existing repo.
3. `opcore status` explains repo coverage, graph readiness, validation readiness, degraded tools, unsupported stacks, and next actions.
4. `opcore check --changed --json` gives any coding agent a stable edit gate.
5. `opcore measure` shows concrete before/after deltas from local history.
6. `opcore init` adds agent guidance/hooks/config only after explicit approval.

ASP remains the independent protocol and manager seam for host/provider authority, receipts, and future ecosystem work. ASP standard claims wait for conformance, hostile-provider coverage, independent provider/host evidence, and explicit maintainer approval.

## Current Implementation Status

The Opcore alpha implementation status is:

| Issue | Status | Result |
|---|---:|---|
| #125 ARC/Epic | closed | Product-first Opcore alpha roadmap landed. |
| #126 Native packaging | closed | Optional native packages exist for `darwin-arm64`, `darwin-x64`, and `linux-x64`; release dry-run consumes built artifacts. |
| #127 TS/JS exports | closed | Graph-core emits export metadata for dead-export metrics. |
| #128 Status | closed | `opcore status` is repo-aware, fast, and read-only. |
| #129 Product facade | closed | `opcore` owns the public `opcore` bin, zero-command scan, and agent check wrapper. |
| #130 Metrics/history | closed | Named drillable metric signals and `opcore measure` landed. |
| #131 Init | closed | `opcore init` is plan-first, additive, approval-gated, and undo-aware. |
| #132 Install skill | not shipped | No `opcore-install` skill is present in `.claude/skills`; installation remains through `opcore init`. |
| #133 Launch docs/demo | closed | `opcore try`, demo docs, quickstart, and claim scrub landed. |

No broad Opcore implementation tree remains open as of this roadmap update. Remaining work is release verification, surface cleanup, and any follow-up issue reconciliation.

## Scope

Opcore alpha must provide value quickly and honestly:

- Time to first useful output should be under 10 minutes.
- Scan/check/measure/status are read-only with respect to source files.
- Scan artifact allowlist:
  `.opcore/report.json`;
  `.opcore/history.jsonl`;
  bounded `.opcore/telemetry.jsonl` capped at 500 records or 1 MiB.
- Init runs a read-only scan first, shows coverage before findings, then may write `.opcore/config`, AGENTS.md guidance, mirrors, undo metadata, and optional hooks only after explicit approval.
- Reports must state coverage before findings: deep TypeScript/JavaScript graph support, Rust validation/toolchain support, experimental Python validation (degraded-honest), and unsupported-language counts.
- Init JSON includes scan, per-language onboarding settings, interaction state, and timing fields for time-to-first-output checks.
- Metrics are named, drillable counts and deltas, not a blended quality score.
- Current Rox/CRG/CIX guardrails remain retained until explicit replacement evidence says otherwise.

## Honest Day-One Signals

Ship only signals the engine can defend:

- TypeScript/JavaScript type and syntax errors.
- TypeScript/JavaScript graph-backed untested surface.
- TypeScript/JavaScript structural/fan-in hotspots and dead exports.
- Rust source-hygiene and suppression-abuse checks.
- Rust oversized files.
- Rust module cycles, orphans, and unresolved module evidence.
- Rust cargo, fmt, clippy, rustdoc, and optional-tool evidence when available, with honest degraded status when tools are missing.
- Python `.py`/`.pyi` graph-backed structure, untested modules, dead exports, syntax, source-hygiene, import graph, relevant-test signals, and optional `python.types` via mypy or pyright with degraded status when tools are missing.
- Unsupported language census with no fake findings.

Do not ship headline claims for generic complexity, TS complexity, Python code analysis, Go/Java analysis, security, cross-repo percentiles, automatic fixes, or old-tool replacement.

## Release Gate

Do not call the alpha ready until current evidence proves:

- `npm run build` succeeds from a clean checkout.
- `npm run release:hygiene` passes with launch-facing docs branded as Opcore.
- `npm run provenance:check` passes and finds no forbidden public-surface claims.
- `npm run cutover:check` proves installed `opcore` scan/status/check/measure flows and keeps `oldToolReplacementClaimed: false`.
- `opcore try --json` returns `opcoreTry.published:false`.
- `opcore --repo . --json` emits the scan artifact allowlist:
  `.opcore/report.json`;
  `.opcore/history.jsonl`;
  bounded `.opcore/telemetry.jsonl` capped at 500 records or 1 MiB.
- `opcore status --repo . --json` does not build graphs, run checks, run setup, install packages, use ACE/current-tool wrappers, or write files.
- `opcore init --repo . --json` previews setup without writing.
- TTY `opcore init --repo .` prompts after the scan and setup plan; declining writes nothing.
- `opcore init --repo . --approve --json` applies additive setup without prompting and still avoids scan artifact writes.
- `opcore check --changed --json` has stable agent exit codes.
- Public docs and package output contain no ASP-standard, old-tool replacement, security/SAST, all-stack, AI-authorship, automatic-fix, or blended-score overclaims.

## Public Wording Rules

Use:

- "Opcore is the robustness loop for agent-era repos."
- "Deep for TypeScript/JavaScript, useful for Rust, and experimental Python validation (degraded-honest) in alpha; unsupported stacks are counted and reported honestly."
- "ASP is an optional private host/provider seam until the protocol has independent interoperability evidence."

Avoid:

- "ASP is the standard."
- "Opcore proves the standard."
- "Opcore replaces Rox/CRG/CIX."
- "Works with every stack."
- "Python code analysis" as a headline.
- "Detects AI authorship."
- "Security scanner" or "SAST."
- "Automatically fixes your repo."
- "Lattice" as product or launch branding.

## Non-Goals

- Public ASP standard launch.
- Old-tool retirement.
- ACE-managed distribution.
- Source-editing or automatic-fix product claims.
- A SaaS dashboard.
- Windows support in `0.1.0`.

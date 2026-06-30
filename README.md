<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/opcore-hero-dark.png">
  <img alt="Opcore — Every change, within tolerance. Layer 02 · Constraints, The Open Engine." src="docs/brand/opcore-hero-light.png" width="100%">
</picture>

<br>

[![version](https://img.shields.io/badge/version-0.1.0--alpha-C2240C?style=flat-square&labelColor=171411)](#)
[![license](https://img.shields.io/badge/license-MIT-171411?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2022-171411?style=flat-square)](#install)
[![platforms](https://img.shields.io/badge/platforms-darwin--arm64%20·%20darwin--x64%20·%20linux--x64-171411?style=flat-square)](#status)
[![checks](https://img.shields.io/badge/checks-deterministic-171411?style=flat-square)](#what-opcore-does-not-do)
[![Layer 02 · The Open Engine](https://img.shields.io/badge/Layer_02-The_Open_Engine-C2240C?style=flat-square&labelColor=171411)](#the-open-engine)

</div>

**Opcore is a deterministic, local, read-only robustness loop and a changed-file validation gate for coding agents.** No cloud. No PR bot. No model grading another model. It builds structural truth from a Rust graph core — dead exports, untested surface, fan-in hotspots, module cycles — prints **coverage before findings**, counts the stacks it *cannot* check instead of faking them, and hands any agent a stable JSON contract with documented exit codes. The only thing it writes is three bounded files under `.opcore/`.

```text
$ opcore

  ┌─ OPCORE ──────────────────────────────────── LAYER 02 · CONSTRAINTS ─┐
  │  ◦ live    deterministic · local · read-only            № 001 · scan  │
  └───────────────────────────────────────────────────────────────────────┘
  ./acme-web   ·   412 files   ·   graph fresh @ HEAD a91f3c2   ·   0.6s

  COVERAGE ── what this pass can actually hold ──────────────────────────
    deep    typescript · javascript   153 files  ███████░░░░░░░░░░░  37%
    useful  rust                       40 files  ██░░░░░░░░░░░░░░░░  10%
    exp.    python (.py/.pyi)           8 files  ░░░░░░░░░░░░░░░░░░   2%   degraded-honest
    none    go                          3 files  ·············  counted, never faked
    ───────────────────────────────────────────────────────────────────────
    graph-supported 128   ·   validation-supported 140 (+12 retained)   ·   degraded tools: none

  FINDINGS ── facts, not a score ───────────────────────────────────────
    7 diagnostics    ↑2 vs HEAD~1
    ├ typescript.types       4   src/router/resolve.ts            TS2345
    ├ typescript.dead-code   2   src/lib/cache.ts › renderFlat    unused export
    ├ rust.clippy            1   crates/graph-core/src/store.rs   needless_clone
    └ structural             1   src/contracts/index.ts           fan-in 41  ← god-file

  GATE   typescript.syntax PASS · types FAIL · tests PASS
         rust.fmt PASS · cargo-check PASS · clippy FAIL
  ───────────────────────────────────────────────────────────────────────
  validation FAILED · 2 checks · wrote .opcore/{report,history,telemetry}
  next  opcore check --changed --json       exit  0 pass · 1 findings · 64 unsupported
```

## Install

> **Alpha.** Package publication is maintainer-controlled during alpha staging. Until the packages are published, run Opcore from a source checkout:

```bash
npm ci && npm run build
node packages/opcore/dist/index.js --version --json
node packages/opcore/dist/index.js init --repo /path/to/repo
```

Local tarballs and `file:` installs from this checkout are useful for smoke tests only. Do not commit machine-specific `file:/...` or `file:../../../Users/...` entries to another repo's `package.json`; use the source checkout during alpha staging, or switch to the registry package after maintainers publish it.

After package publication, install from npm:

```bash
# zero-install first run — nothing written outside .opcore/
npx @the-open-engine/opcore@0.1.0-alpha.0 init

# or install globally / wire the gate into your agent repo
npm install -g @the-open-engine/opcore@0.1.0-alpha.0
npm i -D @the-open-engine/opcore@0.1.0-alpha.0
```

If `opcore` is not found after a global install, check the npm global prefix with `npm prefix -g` and add `$(npm prefix -g)/bin` to your `PATH`.

## First run

```bash
opcore --repo .                 # read-only scan: coverage first, then findings
opcore --version --json         # exact package version + artifact provenance
opcore status --json            # readiness + coverage; never writes
opcore doctor --repo . --json   # runtime/config/check-pack/graph diagnostics
opcore check --changed --json   # the gate any agent can branch on (defaults --base HEAD)
opcore init --repo . --approve  # approval-gated, additive AGENTS.md + .opcore/config
opcore measure --repo .         # concrete before/after deltas from local history
opcore try                      # local sample repos, coverage-first, publishes nothing
```

`opcore`, `status`, `check`, and `measure` never touch your source. The only writer is `opcore init`, and only after you approve the plan.

## The gate

`opcore check --changed --json` is the contract a coding agent runs **before an edit lands** — in the inner loop, not after a PR. Stable exit codes, JSON on stdout, and it works in a freshly `git init` repo with no commits by treating the empty baseline as the comparison base.

```text
$ opcore check --changed

  ┌─ OPCORE · CHANGED ───────────────────────────── vs HEAD · № 001 ─┐
  │   3 files · 6 checks                                 BLOCKED  ✗   │
  └───────────────────────────────────────────────────────────────────┘
    typescript.types   FAIL   src/api/handlers.ts   TS2345  (+2 more)
    rust.clippy        FAIL   crates/core/store.rs  needless_clone
    typescript.syntax  PASS · imports PASS · tests PASS · rust.fmt PASS
  ────────────────────────────────────────────────────────────────────
  out of tolerance · 3 findings · exit 1 · agent-safe JSON on stdout
```

| Exit | Meaning |
| ---: | --- |
| `0` | Within tolerance — no findings. |
| `1` | Findings present, or an error the caller should handle. |
| `2` | Requested check is not implemented for this stack. |
| `64` | Unsupported scope — counted, not failed. |

## Coverage, before findings

Opcore states what it can prove **before** what it found, and it never collapses that into one number.

| Tier | Stacks | What you get |
| --- | --- | --- |
| **Deep** | TypeScript · JavaScript | Graph-backed syntax, types, imports, relevant tests, dead exports, fan-in / god-file hotspots. |
| **Useful** | Rust | Source hygiene, oversized files, module cycles / orphans, `cargo` · `fmt` · `clippy` · `rustdoc`, optional tools — honest `degraded` when a tool is missing. |
| **Experimental** | Python (`.py` / `.pyi`) | Graph structure, untested modules, dead exports, syntax, hygiene. `python.types` via mypy/pyright, degraded-honest. |
| **Counted** | Everything else | Reported as unsupported. No invented findings, no fake coverage. |

## What Opcore does NOT do

The honest boundary is part of the product.

- **No score.** Named, drillable counts only — every signal carries a file path and a check ID.
- **Not a security or vulnerability tool.** That is a different job, and Opcore makes no such claims.
- **It never edits your code.** It reports; you decide. Source files are never touched.
- **No LLM grading an LLM.** Deterministic checks, stable exit codes, reproducible runs.
- **Unsupported stacks are counted, never guessed.** Opcore reports what it cannot check instead of inventing findings.

## How it works

Opcore is a hybrid: a **Rust graph core** owns extraction, persistence, and hot queries; **TypeScript** owns contracts, the CLI, and the validation adapters. The loop is one bin:

`opcore` (scan) → `opcore init` (approval-gated setup) → `opcore check` (the agent gate) → `opcore measure` (deltas from local history).

Findings are read **off the graph**, so they trace to a file, a symbol, and an edge — not a vibe. When no graph is built, Opcore says so instead of reporting a silent zero. Everything it writes lives under `.opcore/` (`report.json`, `history.jsonl`, and bounded `telemetry.jsonl`), and `init` is additive, idempotent, and reversible. The `@the-open-engine/opcore` package exposes only the `opcore` bin. For the package and CLI ownership model, see the runtime and CLI architecture decision at @docs/architecture/runtime-cli-ard.md.

## The Open Engine

Opcore is **Layer 02 · Constraints** of [The Open Engine](https://theopenengine.com) — the open stack for autonomous software production. Generating code is easy; trusting it is not. The engine is layered because trust is layered:

| | Layer | Status |
| --- | --- | --- |
| **01** | Verification — [**Zeroshot**](https://github.com/the-open-engine/zeroshot) | Open · shipping |
| **02** | **Constraints — Opcore** | This repo · alpha |
| 03–05 | Intent · Context · Runtime | In development |

Each layer ships the same way: extracted from the platform we run, then opened.

## ASP provider

Opcore's ASP Core check provider ships as a separate package, `@the-open-engine/opcore-asp-provider`, and launches as `opcore-asp-provider --stdio`. Providers assess; hosts decide.

## Docs

**[Quickstart](docs/quickstart.md) · [Concepts: coverage & findings](docs/concepts.md) · [Agent integration](docs/agent-integration.md) · [Architecture](docs/architecture/runtime-cli-ard.md) (`@docs/architecture/runtime-cli-ard.md`) · [The Open Engine](https://theopenengine.com)**

## Status

Maintainer-controlled alpha (`0.1.0-alpha.0`). Local code scans, honest coverage, setup guidance, and changed-file validation for coding agents. Package artifacts target `darwin-arm64`, `darwin-x64`, and `linux-x64`. Unsupported platforms return typed degraded status instead of crashing. Windows is out of scope for `0.1.0-alpha.0`. Deep for TypeScript/JavaScript, useful for Rust, experimental for Python — and honest about the rest.

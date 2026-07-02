<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/opcore-hero-dark.png">
  <img alt="Opcore" src="docs/brand/opcore-hero-light.png" width="720">
</picture>

<br><br>

**The robustness engine for coding agents.**

A local Rust code graph gives your agent repo-wide understanding, a validation gate that runs before an edit lands, and safe symbol-aware edits.

[![license](https://img.shields.io/badge/license-MIT-171411?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2022-171411?style=flat-square)](#install)
[![platforms](https://img.shields.io/badge/platforms-darwin--arm64%20·%20darwin--x64%20·%20linux--x64-171411?style=flat-square)](#platforms)
[![The Open Engine · Layer 02](https://img.shields.io/badge/The_Open_Engine-Layer_02-C2240C?style=flat-square&labelColor=171411)](#the-open-engine)

</div>

It runs locally, keeps setup approval-gated, and gives agents an exit code they can branch on.

```text
$ opcore check --changed
  1 file changed · checks passed                      CLEARED   exit 0

$ opcore check --changed          # after an agent introduces a type error
  1 file changed · 1 check failed                     BLOCKED   exit 1
  FAIL  typescript.types   src/cart.ts:9   TS2322
```

| Exit | Meaning |
| ---: | --- |
| `0` | Within tolerance. No findings. |
| `1` | Findings present, or an error the caller should handle. |
| `2` | Requested check is not implemented for this stack. |
| `64` | Unsupported scope. Counted, not failed. |

## What your agent gets

Three things, all backed by a Rust code graph that sees what single-file tools miss.

| Your agent can | With | So it can |
| --- | --- | --- |
| Understand the repo | `opcore graph` (query, impact, search), `opcore inspect` (definition, references, symbols, signatures) | see what calls a symbol and what a change reaches, before touching it |
| Validate a change | `opcore check --changed` (stable exit codes), `opcore validate pre-write` | catch type errors, broken imports, and dead code before the write lands |
| Edit safely | `opcore edit` (rename, move, signature, patch) | rename across every call site, applied atomically or not at all |

Symbol-level navigation and refactors are deepest on TypeScript and JavaScript today; Rust and Python are narrower.

## What it checks

What the gate checks, by stack:

| Stack | Depth | Checks |
| --- | --- | --- |
| TypeScript, JavaScript | Deep | Syntax, types, imports, relevant tests, dead exports, fan-in and god-file hotspots. |
| Rust | Useful | Source hygiene, oversized files, module cycles and orphans, cargo, fmt, clippy, rustdoc. |
| Python (`.py`, `.pyi`) | Experimental | Structure, untested modules, dead exports, syntax, hygiene. |

Every finding points to a file, a check ID, and a symbol.

## Getting started

**1. Install.**

```bash
npx @the-open-engine/opcore              # zero-install
# or
npm install -g @the-open-engine/opcore
```

**2. See it work. Nothing gets written.**

```bash
opcore --repo .                          # read-only scan: coverage, then findings
```

**3. Wire the gate into your agent.**

```bash
opcore init                              # scans, shows the plan, asks repo or global, then wires the Claude Code/Codex write gate after you approve
opcore init --global                     # same, for every repo
```

**4. Now every edit is gated.**

```bash
opcore check --changed --json            # runs in your agent's loop; branch on the exit code
```

Install scripts never touch your repo or agent settings; the package only prints a setup reminder. Requires Node >= 22.

## Commands

```bash
opcore status                   # readiness and coverage; never writes
opcore measure --repo .         # before/after deltas from local history
opcore try                      # run the loop on generated sample repos
opcore init --undo --approve    # remove only what Opcore added
```

`opcore check --changed` also takes `--staged` or explicit `<files>`. Only `opcore init` writes setup files, and only after approval; `--json` and non-TTY runs stay plan-only unless you pass `--approve`.

## How it works

Opcore is hybrid: a Rust graph core owns extraction, persistence, and hot queries; TypeScript owns the contracts, CLI, and validation adapters. Findings are read off the graph, so they map to real structure instead of a text match.

Approved repo setup writes additive `.opcore` config, one guidance block, a small write-gate adapter, and merged Claude Code/Codex hook entries. Approved global setup writes user-level hook config under the same additive, undoable policy. For the ownership model, see @docs/architecture/runtime-cli-ard.md.

## Platforms

`darwin-arm64`, `darwin-x64`, and `linux-x64`. Other platforms return a clear status instead of crashing.

## Docs

[Quickstart](docs/quickstart.md) · [Concepts](docs/concepts.md) · [Examples](docs/examples.md) · [Agent integration](docs/agent-integration.md) · [Architecture](docs/architecture/runtime-cli-ard.md)

## The Open Engine

Opcore is Layer 02 (Constraints) of [The Open Engine](https://theopenengine.com), sibling to [Zeroshot](https://github.com/the-open-engine/zeroshot) (Layer 01, Verification).

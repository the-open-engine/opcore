<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/opcore-hero-dark.png">
  <img alt="Opcore" src="docs/brand/opcore-hero-light.png" width="720">
</picture>

<br><br>

**The changed-file validation gate a coding agent runs before an edit lands.**

Backed by a Rust code graph that reads dead exports, untested surface, fan-in hotspots, and Rust module cycles.

[![license](https://img.shields.io/badge/license-MIT-171411?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2022-171411?style=flat-square)](#install)
[![platforms](https://img.shields.io/badge/platforms-darwin--arm64%20·%20darwin--x64%20·%20linux--x64-171411?style=flat-square)](#platforms)
[![The Open Engine · Layer 02](https://img.shields.io/badge/The_Open_Engine-Layer_02-C2240C?style=flat-square&labelColor=171411)](#the-open-engine)

</div>

It runs locally, never changes your source, and ends every check in an exit code your agent can branch on.

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

## What it checks

A Rust code graph sees structure that single-file linters cannot: exports with no importer, symbols with no test, and modules that everything depends on.

| Stack | Depth | Checks |
| --- | --- | --- |
| TypeScript, JavaScript | Deep | Syntax, types, imports, relevant tests, dead exports, fan-in and god-file hotspots. |
| Rust | Useful | Source hygiene, oversized files, module cycles and orphans, cargo, fmt, clippy, rustdoc. |
| Python (`.py`, `.pyi`) | Experimental | Structure, untested modules, dead exports, syntax, hygiene. |

Every finding points to a file, a check ID, and a symbol.

## Install

```bash
npx @the-open-engine/opcore              # zero-install first run
npm install -g @the-open-engine/opcore   # global CLI
npm i -D @the-open-engine/opcore         # wire the gate into an agent repo
```

Requires Node >= 22.

## Commands

```bash
opcore --repo .                 # read-only scan: coverage, then findings
opcore status                   # readiness and coverage; never writes
opcore check --changed --json   # the agent gate; also --staged or explicit <files>
opcore init --repo . --approve  # approval-gated, additive AGENTS.md + .opcore/config
opcore measure --repo .         # before/after deltas from local history
opcore try                      # run the loop on generated sample repos
```

Only `opcore init` writes to your repo, and only after you approve its plan.

## How it works

Opcore is hybrid: a Rust graph core owns extraction, persistence, and hot queries; TypeScript owns the contracts, CLI, and validation adapters. Findings are read off the graph, so they map to real structure instead of a text match. It writes `.opcore/report.json`, `.opcore/history.jsonl`, and bounded `.opcore/telemetry.jsonl`, plus one `AGENTS.md` block and one `.gitignore` line when you approve `opcore init`. For the ownership model, see @docs/architecture/runtime-cli-ard.md.

## Platforms

`darwin-arm64`, `darwin-x64`, and `linux-x64`. Other platforms return a clear status instead of crashing.

## Docs

[Quickstart](docs/quickstart.md) · [Concepts](docs/concepts.md) · [Examples](docs/examples.md) · [Agent integration](docs/agent-integration.md) · [Architecture](docs/architecture/runtime-cli-ard.md)

## The Open Engine

Opcore is Layer 02 (Constraints) of [The Open Engine](https://theopenengine.com), sibling to [Zeroshot](https://github.com/the-open-engine/zeroshot) (Layer 01, Verification).

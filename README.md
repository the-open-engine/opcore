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

## What it checks

A Rust code graph sees structure that single-file linters cannot: exports with no importer, symbols with no test, and modules that everything depends on.

| Stack | Depth | Checks |
| --- | --- | --- |
| TypeScript, JavaScript | Deep | Syntax, types, imports, relevant tests, dead exports, fan-in and god-file hotspots. |
| Rust | Useful | Source hygiene, oversized files, module cycles and orphans, cargo, fmt, clippy, rustdoc. |
| Python (`.py`, `.pyi`) | Experimental | Structure, untested modules, dead exports, syntax, hygiene. |

Every finding points to a file, a check ID, and a symbol.

## Install And Wire The Gate

```bash
npx opcore install
```

`opcore install` scans first, shows the plan, and asks before writing on a TTY. In a Git repo, it asks whether to install the Claude Code/Codex write gate for this repo or globally. The default repo setup installs the Opcore agent skill, Claude Code/Codex write-gate hooks, and a Git pre-commit hook that runs `opcore check --changed` when no existing pre-commit hook is present.

For an explicit global install:

```bash
npm install -g opcore
opcore install --global
```

Install scripts do not modify repos or agent settings. The package only prints a setup reminder. Requires Node >= 22.

## Commands

```bash
opcore --repo .                 # read-only scan: coverage, then findings
opcore status                   # readiness and coverage; never writes
opcore check --changed --json   # the agent gate; also --staged or explicit <files>
opcore install                  # scan, then wire repo/global agent hooks after approval
opcore install --global         # install the write gate for all repos using global settings
opcore uninstall --yes          # remove only what Opcore added
opcore measure --repo .         # before/after deltas from local history
opcore try                      # run the loop on generated sample repos
```

Only `opcore install` and the compatibility `opcore init` path write setup files, and only after approval. `--json` and non-TTY runs stay plan-only unless you pass `--yes` for install or `--approve` for init.

## How it works

Opcore is hybrid: a Rust graph core owns extraction, persistence, and hot queries; TypeScript owns the contracts, CLI, and validation adapters. Findings are read off the graph, so they map to real structure instead of a text match.

Approved repo setup writes additive `.opcore` config, one guidance block, the Opcore agent skill, a small write-gate adapter, merged Claude Code/Codex hook entries, an active Git pre-commit hook when safe, and undo metadata. Approved global setup writes user-level hook config and skills under the same additive, undoable policy. For the ownership model, see @docs/architecture/runtime-cli-ard.md.

## Platforms

`darwin-arm64`, `darwin-x64`, and `linux-x64`. Other platforms return a clear status instead of crashing.

## Docs

[Quickstart](docs/quickstart.md) · [Concepts](docs/concepts.md) · [Examples](docs/examples.md) · [Agent integration](docs/agent-integration.md) · [Architecture](docs/architecture/runtime-cli-ard.md)

## The Open Engine

Opcore is Layer 02 (Constraints) of [The Open Engine](https://theopenengine.com), sibling to [Zeroshot](https://github.com/the-open-engine/zeroshot) (Layer 01, Verification).

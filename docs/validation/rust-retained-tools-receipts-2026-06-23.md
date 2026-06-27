# Rust Retained Tools Receipts - 2026-06-23

Issue: #61.

Runtime decision: #21 remains Option A: no validation daemon and no hidden validation cache. Opcore emits provider
assessment evidence only; ASP hosts keep decision authority.

## Native Parity Closed

The five retained Rust rows now have native Opcore behavior when supporting tools are available:

| Check | Native receipt |
|---|---|
| `rust.rustdoc` | `cargo doc --no-deps --all-features --message-format=json`; rustdoc diagnostics block, missing rustdoc is `unsupported_request`. |
| `rust.import-graph` | fileView-based unresolved `mod`, unresolved `crate`/`self`/`super` use paths, orphan sources, and cycles. |
| `rust.dead-code` | Cargo `dead_code` diagnostics plus native orphan-source dead-code evidence. |
| `rust.unused-deps` | cargo-udeps workspace/package scoping and sorted `RUST_UNUSED_DEPENDENCY` diagnostics. |
| `rust.function-metrics` | rust-code-analysis object/array JSON parsing with lines, complexity, and parameter thresholds. |

With a full fake Rust toolchain, status and doctor tests prove the Rust adapter is `available` with
`degradedChecks: []`. In this local environment `cargo-depgraph` is absent, so live status/doctor correctly show only:

```json
{"checkId":"rust.import-graph","requiredTool":"cargo-depgraph","reason":"optional_tool_unavailable"}
```

`rust.dead-code` has no generic retained row when core Cargo is available.

## Opcore Receipts

| Command | Result |
|---|---|
| `npm run build` | pass |
| targeted validation Rust/CLI/contracts/schema/gate tests | pass, 127 tests |
| `node packages/cli/dist/index.js check manifest --json` | pass, includes `rust.file-length` |
| `node packages/cli/dist/index.js validate manifest --json` | pass, includes `rust.file-length` |
| `node packages/cli/dist/index.js status --json` | pass, Rust adapter degraded only for missing `cargo-depgraph` |
| `node packages/cli/dist/index.js doctor --json` | pass, Rust adapter degraded only for missing `cargo-depgraph` |
| `npm run rust:check` | pass |
| `npm run ci` | pass, 423 tests |
| `npm run setup:tools` | pass |
| `npm run current-tools:validate-rust-graph` | pass, `[]` |
| `npm run current-tools:validate-changed` | pass, 6 baseline-equivalent legacy findings retained |
| `npm run current-tools:validate-all` | pass, no issues found |

## External Old-Tool Receipts

Orchestra remains strict and green:

| Command | Result |
|---|---|
| `npm run rox:ci` | pass, no issues found |
| `npm run rox:repo` | pass, no issues found |
| `npm run rox:check` | pass, no issues found |

Gateway remains retained evidence with exit 2 and 11 existing findings. The finding list is preserved in
`docs/validation/rust-retained-tools-receipts-2026-06-23.json`; no thresholds were relaxed.

## Guardrails

- No validation daemon.
- No hidden validation cache.
- No Rox imports, Rox cache reads, or Rox shellouts from native Opcore checks.
- Current external Rox gates stay active until downstream #27/#28/#29 accept replacement evidence.
- Results are provider assessments only, not ASP host decisions or release authority.

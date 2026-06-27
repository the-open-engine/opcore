# Rust Adapter Parity Evidence

Status: private dogfood and release-readiness evidence for #20, #21, #28, and the #30 validation-doc slice.

Source rows: `agent-server-protocol/docs/planning/old-tool-compatibility-matrix.{md,json}` Rust validation rows
`lattice-rox-rust-adapter-and-function-metrics`, `orchestra-rox-rust-gate`, `orchestra-rox-native-dependencies`,
`covibes-gateway-rox-rust-gate`, `robustness-engine-rust-adapter-source`, and
`robustness-engine-cargo-manifest-handling`.

## #30 Validation Retirement Decisions

This is private release-readiness documentation only. It is not a publish action, visibility change, public
announcement, public replacement claim, or old-tool retirement approval.

Decision policy for #30 validation docs: no surface is `replaced` unless installed-artifact receipt evidence proves the
exact replacement and maintainer approval accepts retirement for that surface. The landed #29 comparison receipt does
not make a retirement decision, pins `oldToolReplacementClaimed: false`, and records no public release actions. It
landed through PR #104 at merge `ab0362d339ec2c41b0cc71ae5bb400c4b8254e36`.

Evidence anchors:

- [#29 Rust old-Rox comparison receipt](rust-old-rox-comparison-receipt-2026-06-27.json) and
  [summary](rust-old-rox-comparison-receipt-2026-06-27.md).
- [#30 cutover receipt](../release/cutover-receipt.json) and
  [summary](../release/cutover-receipt.summary.md). The receipt proves installed command coverage, including Rust graph
  command receipts, but it does not include maintainer approval to retire Rust retained-tool rows.

| Surface | Decision | Evidence | Why retirement is not accepted | Current guardrail action |
|---|---|---|---|---|
| `rust.rustdoc` | retained | #29 receipt records no graph replacement evidence. | Rustdoc diagnostics, broken intra-doc links, and documentation-policy failures remain unique current-tool evidence. No installed-artifact receipt plus maintainer approval proves exact replacement. | Keep current external Rust guardrails active for rustdoc coverage. |
| `rust.import-graph` | deferred | #29 records Rust graph `IMPORTS_FROM`/`DEPENDS_ON` facts; #30 records installed Rust graph build/query/impact/review-context/detect-changes/search receipts. | Graph facts are useful parity evidence, but rustdoc and cargo-depgraph-enriched import checks remain retained where graph facts are not sufficient. No maintainer approval flips this row. | Keep current external import-graph guardrails active while native graph evidence complements them. |
| `rust.dead-code` | retained | #29 records exported symbol metadata and graph-backed dead-public-export signals. | Cargo `dead_code` diagnostics and compiler reachability remain uniquely provided by current tools. Graph dead-public-export evidence is not exact replacement evidence. | Keep current external dead-code guardrails active. |
| `rust.unused-deps` | retained | #29 records no graph replacement evidence. | Cargo-udeps unused dependency analysis remains the unique evidence source. | Keep current external unused-dependency guardrails active. |
| `rust.function-metrics` | retained | #29 records Rust function/method spans and signatures; #30 records installed Rust graph receipts. | Rust-code-analysis complexity, line-count, and parameter-threshold metrics remain unique current-tool evidence. Spans/signatures are not exact metric replacement evidence. | Keep current external function-metric guardrails active. |
| `current-tools:validate-rust-graph` | retained | #29 records the aggregate Rust graph guardrail as retained; #30 Rust receipts are graph-owned installed command receipts. | No receipt proves an exact aggregate replacement for the current-tools Rust graph gate, and no maintainer approval retires it. | Continue running `npm run current-tools:validate-rust-graph`. |
| Rust portion of `current-tools:validate-changed` | retained | #30 installed `opcore check changed` receipt uses `--checks typescript.syntax`; #29 carries only Rust comparison evidence with `oldToolReplacementClaimed: false`. | The installed changed-check receipt does not exercise Rust retained-tool coverage, and no Tom approval flips Rust changed-file guardrails. | Continue running `npm run current-tools:validate-changed` for changed Rust-owned inputs and mixed changes. |

## Native Rust Checks

`@the-open-engine/opcore-validation-rust` exports these provider assessment checks:

| Check | Native behavior | Retained compatibility |
|---|---|---|
| `rust.source-hygiene` | Rejects `.inc`, `include!(...)`, `rustfmt::skip`, `allow(dead_code)`, broad `allow`/`expect`, and owned lint suppressions. | none for covered inputs |
| `rust.fmt` | Runs rustfmt or cargo fmt in a temporary workspace. | current external gate stays until #27 self-dogfood proof |
| `rust.cargo-check` | Runs structured Cargo metadata and `cargo check --message-format=json`. | current external gate stays until #21 runtime/cache decision |
| `rust.clippy` | Runs `cargo clippy` with Opcore-owned lint set. | current external gate stays until #21 runtime/cache decision |
| `rust.rustdoc` | Runs `cargo doc --no-deps --all-features --message-format=json`; rustdoc diagnostics are blocking policy evidence. | unsupported when rustdoc is missing; retain old gate |
| `rust.import-graph` | Reports unresolved `mod`, unresolved `crate`/`self`/`super` use paths, orphan source files, and module cycles from fileView after-state content. | cargo-depgraph enrichment remains degraded when unavailable |
| `rust.dead-code` | Runs `cargo check` with `dead_code` denied and adds native orphan-source dead-code evidence. | core Cargo absence makes adapter unavailable; old gates stay active |
| `rust.graph-signals` | Reports graph-backed untested public Rust surface, dead public exports, module orphans, and module cycles through `ValidationGraphProviderClient`. | requires available graph facts; does not replace cargo/rustdoc/clippy/Rox guardrails |
| `rust.unused-deps` | Runs cargo-udeps with workspace or package scoping and parses unused dependency names into deterministic diagnostics. | unsupported when cargo-udeps is missing; retain old gate |
| `rust.function-metrics` | Runs rust-code-analysis-cli JSON object/array output and enforces 80 lines, complexity 10, params 4. | unsupported when tool is missing; retain old gate |

## Retained Compatibility Ledger

`opcore status --json` and `opcore doctor --json` must report retained blockers in `degradedChecks` only when a
supporting retained tool is missing. With `rustdoc`, `cargo-depgraph`, `cargo-udeps`, and `rust-code-analysis-cli`
available, the Rust adapter is `available` with `degradedChecks: []`. Missing-tool entries are not passing no-op checks;
they are machine-readable cutover blockers for #27/#28/#29.

| Check | Opcore | Orchestra | CoVibes | Gateway | Required tool when degraded | Follow-up |
|---|---:|---:|---:|---:|---|---|
| `rust.rustdoc` | no | yes | no | yes | `rustdoc` | #27/#28/#29 |
| `rust.import-graph` | no | yes | no | yes | `cargo-depgraph` | #27/#28/#29 |
| `rust.dead-code` | no | yes | no | yes | core `cargo` only | #27/#28/#29 |
| `rust.graph-signals` | yes | no | yes | yes | graph provider | #28/#29 |
| `rust.unused-deps` | no | yes | no | yes | `cargo-udeps` | #27/#28/#29 |
| `rust.function-metrics` | yes | yes | no | yes | `rust-code-analysis-cli` | #27/#28/#29 |

Cargo.lock-only changes are retained compatibility too. Current native ownership covers `.rs`, `.inc`, and
`Cargo.toml`; lockfile-only policy remains under #21 until an explicit cutover decision expands ownership.

## Scope And Overlay Evidence

Rust-owned inputs are `.rs`, `.inc`, and `Cargo.toml`. Cargo.lock-only changes are explicitly skipped as retained compatibility. Tree scope uses committed Git tree content through the validation workspace. Pre-write and hypothetical requests use fileView after-state overlays and temporary materialization for Cargo tools.

Representative Opcore diffs:

```diff
diff --git a/crates/graph-core/src/lib.rs b/crates/graph-core/src/lib.rs
+#[allow(dead_code)]
+pub fn hidden_regression() {}
```

Expected native result: `rust.source-hygiene` returns `policy_failure` with `RUST_SOURCE_ALLOW_DEAD_CODE`.

```diff
diff --git a/Cargo.toml b/Cargo.toml
@@
-members = ["crates/graph-core"]
+members = ["crates/graph-core", "crates/new-member"]
```

Expected native result: Rust checks run because Cargo.toml is adapter-owned. Missing package/toolchain failures are typed as `policy_failure`, `unsupported_request`, or `infrastructure_failure`, not silent skips.

Representative Orchestra comparison diffs:

```diff
diff --git a/crates/orchestra-core/src/lib.rs b/crates/orchestra-core/src/lib.rs
+pub fn unchecked(values: Vec<i32>) -> i32 { values[3] }
```

Expected native result: `rust.clippy` reports owned lint diagnostics when run beside Orchestra current gates. Orchestra must keep `npm run rox:ci`, `npm run rox:repo`, and `npm run rox:check` until #28 records replacement evidence from the same diff.

## #21 Runtime Facts

- Temporary workspace materialization is required for Cargo-backed checks.
- Missing `cargo`, `rustfmt`, or `clippy` makes the Rust adapter unavailable. Missing `rustdoc`, `cargo-udeps`,
  `cargo-depgraph`, or `rust-code-analysis-cli` keeps the Rust adapter degraded and annotates the retained blocker
  entry with `requiredTool`; no generic retained entries remain when those tools are available.
- Retained blocker entries include `currentUsage` booleans for Opcore, Orchestra, CoVibes, and gateway consumers.
- cargo-depgraph is optional enrichment for `rust.import-graph`; missing state is degraded, not a policy failure.
- cargo-udeps and rust-code-analysis-cli are required for their selected checks; missing state returns `unsupported_request`.
- #61 adds no validation daemon, hidden validation cache, Rox import, Rox cache read, or Rox shellout from native checks.

## Retained Guardrails

Keep Opcore current external Rust guardrails until #21/#27 accept parity and runtime behavior:

```sh
npm run current-tools:validate-rust-graph
npm run current-tools:validate-changed
npm run current-tools:validate-all
```

Keep Orchestra current gates until #28 records safe comparison evidence:

```sh
cd ../orchestra
npm run rox:ci
npm run rox:repo
npm run rox:check
```

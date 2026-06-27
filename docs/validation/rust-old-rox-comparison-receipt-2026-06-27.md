# Rust Old-Rox Comparison Receipt - 2026-06-27

Issue: #29.

Machine receipt: `docs/validation/rust-old-rox-comparison-receipt-2026-06-27.json`

This receipt records Rust graph evidence without making a retirement decision. `oldToolReplacementClaimed` is pinned to `false`, and no public release or publish action is recorded.

| Surface | Graph Evidence | Still Unique To Current Tools | Status |
|---|---|---|---|
| `rust.rustdoc` | none | rustdoc diagnostics and documentation-policy failures | retained |
| `rust.import-graph` | Rust module/import graph facts plus query and impact receipts | rustdoc/cargo-depgraph-enriched import checks | deferred |
| `rust.dead-code` | exported symbol metadata and graph-backed dead-public-export signals | Cargo `dead_code` compiler reachability | retained |
| `rust.unused-deps` | none | cargo-udeps unused dependency analysis | retained |
| `rust.function-metrics` | Rust function/method spans and signatures | rust-code-analysis complexity and threshold metrics | retained |
| `current-tools:validate-rust-graph` | none | aggregate retained Rust graph guardrail | retained |

`npm run current-tools:validate-rust-graph` remains active until #30 explicitly changes retained-tool policy.

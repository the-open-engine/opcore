# Retained Guardrail Matrix

Issue: #54

Status: master retained-guardrail matrix for Opcore epic #13.

This matrix records current Rox, CRG, and CIX guardrail status after the #13 parity-ledger work. It is private release-readiness evidence only. It is not a public release, npm publish, registry or certification claim, ASP authority claim, ACE wrapper cutover, or old-tool retirement announcement.

## Invariant

No surface is marked `replaced` unless an installed Opcore receipt proves exact replacement for that surface and the release/cutover issue explicitly accepts the replacement. Until then, current external Rox, CRG, and CIX guardrails remain retained or replacement-deferred.

`docs/release/asp-dogfood-receipt.json` pins `oldToolReplacementClaimed: false`. That value must stay false until a later installed-artifact receipt authorizes a surface-specific replacement claim.

## Receipt Sources

- `docs/release/crg-graph-parity-ledger.md` (#53): CRG graph parity ledger and issue-number collision note.
- `docs/release/graph-release-receipt.json` (#17): graph release command coverage and serve transport evidence.
- `docs/release/cutover-receipt.json` (#30): installed `node_modules/.bin/opcore` command receipts, with `opcoreBinOnly:true` and old bins absent from the cutover environment.
- `docs/release/asp-dogfood-receipt.json` (#120): advisory ASP dogfood, retained current-tool guardrails, inspect/edit deferred coverage, and `oldToolReplacementClaimed: false`.
- `docs/validation/rust-adapter-parity.md`, `docs/validation/rust-retained-tools-receipts-2026-06-23.md`, and `docs/validation/rust-old-rox-comparison-receipt-2026-06-27.json` (#29, PR #104 merge `ab0362d339ec2c41b0cc71ae5bb400c4b8254e36`): Rust adapter parity, retained Rox compatibility evidence, and the #29 comparison evidence consumed by #30 per-surface Rust decisions with `oldToolReplacementClaimed: false`.
- `docs/release/inspect-signature-parity.md` and `docs/release/inspect-implementations-parity.md`: CIX inspect parity evidence and retained gaps.

## Matrix

| Current guardrail surface | Opcore/lattice evidence | Matrix state | Guardrail decision |
|---|---|---|---|
| CRG graph: build/update/watch/status/query/impact/review-context/detect-changes/search/serve | `crg-graph-parity-ledger.md`; `graph-release-receipt.json` command coverage; `cutover-receipt.json` graph command receipts from installed artifacts with `environmentIsolation.oldBinsAbsent.{crg,cix,rox}: true`. | `deferred` | Parity is demonstrated, but replacement claim is deferred. CRG remains the retained graph guardrail until downstream cutover work accepts retirement. |
| Rox validation - TS/JS: `typescript.syntax`, `typescript.types`, `typescript.import-graph`, `typescript.dead-code`, `typescript.relevant-tests` | `release-receipt.json` validation check ids; `cutover-receipt.json` validation receipts: `opcore-check-changed`, `check-files`, `validate-request`, `validate-pre-write-pass`, and fail-closed `validate-pre-write-fail`. | `deferred` | Installed validation receipts exist, but Rox changed/repo guardrails remain active through `current-tools:validate-changed` and `current-tools:validate-all`. No old-tool replacement claim. |
| Rox validation - Rust foundation: `rust.source-hygiene`, `rust.fmt`, `rust.cargo-check`, `rust.clippy`, `rust.file-length` | `rust-adapter-parity.md` native Rust checks; `rust-retained-tools-receipts-2026-06-23.md`; `asp-dogfood-receipt.json` retained current-tool guardrails. | `retained` | Keep Rox Rust gates active. Runtime, cache, and retirement decisions feed #10/#26-#30 rather than #13. |
| Rox validation - Rust retained tool: `rust.rustdoc` | `rust-adapter-parity.md` records rustdoc diagnostics as blocking policy evidence and keeps retained guardrails active when `rustdoc` is missing; `rust-old-rox-comparison-receipt-2026-06-27.json` records no graph fact replacing rustdoc diagnostics and `replacementStatus: "retained"`. | `retained` | #30 decision: retain. No installed-artifact receipt or maintainer approval flips this surface. Rustdoc diagnostics, broken intra-doc links, and documentation-policy failures remain current-tool evidence. |
| Rox validation - Rust retained tool: `rust.import-graph` | `rust-adapter-parity.md` records native unresolved module/use path, orphan source, and module-cycle checks with optional `cargo-depgraph` enrichment; `rust-old-rox-comparison-receipt-2026-06-27.json` records Rust graph evidence exists but `replacementStatus: "deferred"`. | `deferred` | #30 decision: defer replacement. Rust graph facts are useful evidence, but cargo-depgraph-enriched import checks and retained current-tool behavior are not exactly replaced, and no maintainer approval authorizes retirement. |
| Rox validation - Rust retained tool: `rust.dead-code` | `rust-adapter-parity.md` records native `cargo check` `dead_code` denial plus orphan-source evidence; `rust-old-rox-comparison-receipt-2026-06-27.json` records graph-backed dead-public-export evidence but `replacementStatus: "retained"`. | `retained` | #30 decision: retain. Graph signals do not replace Cargo compiler reachability or current-tool gate behavior, and `oldToolReplacementClaimed` stays false. |
| Rox validation - Rust retained tool: `rust.unused-deps` | `rust-adapter-parity.md` records `cargo-udeps` parsing and degraded/unsupported behavior when the tool is missing; `rust-old-rox-comparison-receipt-2026-06-27.json` records no graph fact replacing cargo-udeps unused dependency analysis and `replacementStatus: "retained"`. | `retained` | #30 decision: retain. Unused dependency evidence remains uniquely provided by cargo-udeps/current tools until an installed-artifact receipt and approval accept replacement. |
| Rox validation - Rust retained tool: `rust.function-metrics` | `rust-adapter-parity.md` records `rust-code-analysis-cli` metrics for line count, complexity, and parameter thresholds; `rust-old-rox-comparison-receipt-2026-06-27.json` records graph spans/signatures exist but `replacementStatus: "retained"`. | `retained` | #30 decision: retain. Rust graph symbol spans do not exactly replace rust-code-analysis metrics or threshold behavior. |
| Rox validation - Rust aggregate gate: `current-tools:validate-rust-graph` | `rust-adapter-parity.md` lists `npm run current-tools:validate-rust-graph` as a retained guardrail; `rust-old-rox-comparison-receipt-2026-06-27.json` records this aggregate gate with `replacementStatus: "retained"` and `oldToolReplacementClaimed: false`. | `retained` | #30 decision: retain the aggregate Rust graph current-tool gate. The #29 receipt is comparison evidence only and does not retire the command. |
| Rox validation - Rust changed-file current-tool gate: `current-tools:validate-changed` | `rust-adapter-parity.md` lists `npm run current-tools:validate-changed` as a retained guardrail for Rust parity work; `asp-dogfood-receipt.json` records the changed-file current-tool guardrail as passed retained evidence. | `retained` | #30 decision: retain the Rust-relevant changed-file current-tool gate. No #29/#30 installed-artifact receipt or approval authorizes replacing this command. |
| CIX inspect: symbols/definition/references/signature/implementations/search | `cutover-receipt.json` inspect receipts: `inspect-symbols`, `inspect-definition`, `inspect-references`, `inspect-signature`, `inspect-implementations`, and `inspect-search`; `inspect-signature-parity.md`; `inspect-implementations-parity.md`; #49 node-id references fix. | `deferred` | Installed inspect receipts exist, but ASP dogfood still records inspect as `parity-blocker` because ASP inspect request/response mapping is outside #120. CIX remains retained until an inspect-specific cutover accepts replacement. |
| CIX edit: exact/multi/search-replace/patch/tree/rename/move/signature | `cutover-receipt.json` edit receipts: `edit-preview`, `edit-apply`, and fail-closed `edit-refused`; edit behavior remains under edit-owned validation plans. | `retained` | `asp-dogfood-receipt.json` marks edit `retained-old-tool-gate`: ASP dogfood does not authorize edits or apply behavior. CIX edit remains retained until edit-specific installed receipts and ASP/host authority decisions accept replacement. |

No row is currently `replaced`.

## Current Retained Gates

These commands remain active retained guardrails:

```sh
npm run current-tools:validate-changed
npm run current-tools:validate-rust-graph
npm run current-tools:validate-all
```

`rust-old-rox-comparison-receipt-2026-06-27.json` records `current-tools:validate-rust-graph` as retained for #30 comparison purposes. `rust-adapter-parity.md` keeps both `current-tools:validate-rust-graph` and `current-tools:validate-changed` active for Rust parity work. `asp-dogfood-receipt.json` records `current-tools-validate-changed` and `current-tools-validate-rust-graph` as passed retained guardrails, while `current-tools-validate-all` remains `retained-not-run` unless explicitly requested.

## Issue Truth-Up Queue

After this matrix lands, update these coordination issues with the matrix link and the same current truth:

- Opcore #13: #54 closes the retained old-tool guardrail matrix; no row is replaced and `oldToolReplacementClaimed:false` remains pinned.
- Opcore #30: old-tool retirement remains deferred; CRG graph has installed parity receipts, but the #29 Rust comparison receipt keeps `rust.rustdoc`, `rust.dead-code`, `rust.unused-deps`, `rust.function-metrics`, `current-tools:validate-rust-graph`, and Rust `current-tools:validate-changed` retained, keeps `rust.import-graph` deferred, and keeps `oldToolReplacementClaimed:false`.
- Opcore #10 / #26-#30: Rust parity rows remain owned by the Rust graph/Rox-retirement lane; #54 does not retire Rox.
- `the-open-engine/agent-server-protocol#26`: ASP #18 has closed with Option A accepted: no edit/inspect daemon and installed cold-start is acceptable. ASP coordination should now treat Opcore as one enrolled provider/server, not the host or authority. ACE remains an optional downstream host client. Inspect remains a parity blocker and edit remains a retained old-tool gate until ASP request/response and host-authority work accepts replacement.

Do not update public docs, publish packages, announce retirement, or change repository visibility from this matrix.

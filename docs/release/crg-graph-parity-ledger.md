# CRG Graph Parity Ledger

Issue: #53

Status: CRG graph parity is demonstrated for `opcore graph`; replacement remains deferred.

## Scope

This ledger enumerates CRG-to-`opcore graph` parity from retained receipts only. It is release evidence, not a public retirement claim, npm publish action, ASP authority claim, or ACE wrapper cutover.

Receipt sources:

- `docs/release/graph-release-receipt.json` issue `#17`, regenerated with in-repo fixture `packages/fixtures/source-extraction/wave1`.
- `docs/release/cutover-receipt.json` issue `#30`, generated `2026-06-27T10:22:13.799Z`, installed `node_modules/.bin/opcore` proof with `environmentIsolation.opcoreBinOnly: true` and `environmentIsolation.oldBinsAbsent.{crg,cix,rox}: true`.
- `docs/release/asp-dogfood-receipt.json` issue `#120`, generated `2026-06-26T19:04:19.583Z`, with `oldToolReplacementClaimed: false` and retained current-tool guardrails.

## Issue Namespace

The graph fixtures and receipts use covibes-tree issue numbers for older graph-release work. In that namespace, `#13`, `#14`, `#15`, and `#16` are graph optional-surface children of graph parent `#4` and graph-release gate `#17`: coverage, flows, communities, and read-only suggestions.

Those numbers collide with the Opcore GitHub issue namespace. This document is Opcore issue `#53`, under Opcore epic `#13`; do not map covibes-tree `#13`-`#16` to Opcore-tree epics.

## Implemented Surface Ledger

| Surface | Status | Receipt evidence |
|---|---|---|
| `opcore graph build` | implemented | `graph-release-receipt.json` `commandCoverage.id=opcore-graph-build` on `wave1`; `cutover-receipt.json` `commandReceipts.id=graph-build`, status `ok`, exit 0 from `node_modules/.bin/opcore`, assertion `graph build completed with native artifact`. |
| `opcore graph update` | implemented | `graph-release-receipt.json` `commandCoverage.id=opcore-graph-update`, passed exit 0 in 664ms on `wave1`. The cutover receipt does not duplicate update. |
| `opcore graph watch` | implemented | `graph-release-receipt.json` `commandCoverage.id=opcore-graph-watch`, passed exit 0 in 609ms on `wave1`. The cutover receipt does not duplicate watch. |
| `opcore graph status` | implemented | `graph-release-receipt.json` `commandCoverage.id=opcore-graph-status`, passed exit 0 in 619ms on `wave1`; `cutover-receipt.json` `commandReceipts.id=graph-status`, status `ok`, exit 0, assertion `graph status available after build`. |
| `opcore graph query` | implemented | `graph-release-receipt.json` `commandCoverage.id=opcore-graph-query`, passed exit 0 in 603ms on `wave1`; `cutover-receipt.json` `commandReceipts.id=graph-query`, status `ok`, exit 0, assertion `graph query returned facts`. |
| `opcore graph impact` | implemented | `graph-release-receipt.json` `commandCoverage.id=opcore-graph-impact`, passed exit 0 in 617ms on `wave1`; `cutover-receipt.json` `commandReceipts.id=graph-impact`, status `ok`, exit 0, command includes `--files src/components/GreetingCard.tsx`, assertion `graph impact returned file impact`. |
| `opcore graph review-context` | implemented | `cutover-receipt.json` `commandReceipts.id=graph-review-context`, status `ok`, exit 0 from `node_modules/.bin/opcore`, command includes `--files src/components/GreetingCard.tsx`, assertion `graph review-context returned related facts`. The graph-release receipt does not include review-context. |
| `opcore graph detect-changes` | implemented | `cutover-receipt.json` `commandReceipts.id=graph-detect-changes`, status `ok`, exit 0 from `node_modules/.bin/opcore`, command includes `--files src/components/GreetingCard.tsx`, assertion `graph detect-changes returned typed change data`. The graph-release receipt does not include detect-changes. |
| `opcore graph search` | implemented | `graph-release-receipt.json` `commandCoverage.id=opcore-graph-search`, passed exit 0 in 644ms on `wave1`; `cutover-receipt.json` `commandReceipts.id=graph-search`, status `ok`, exit 0, command `graph search Greeting --limit 5`, assertion `graph search returned ranked results`. |
| `opcore graph serve` | implemented | `graph-release-receipt.json` `commandCoverage.id=opcore-graph-serve`, passed exit 0 in 555ms on `wave1`; `graph-release-receipt.json` `serveTransport` passed ping/status/query/search/shutdown over `opcore.graph.daemon`; `cutover-receipt.json` `commandReceipts.id=graph-serve`, status `ok`, exit 0, assertion `graph serve status route is ready`. |

Combined receipts cover all 10 required surfaces at least once. `graph-release-receipt.json` covers build, update, watch, status, query, impact, search, and serve. `cutover-receipt.json` covers build, status, query, impact, review-context, detect-changes, search, and serve from installed artifacts with old bins absent.

## Deferred Optional Analyses

Optional graph analyses remain non-blocking and deferred in `packages/fixtures/graph-reference-evidence/manifest.json` and `docs/release/graph-release-receipt.json`:

| Covibes-tree issue | Surface | Classification | Status |
|---|---|---|---|
| `#13` | coverage | deferred | deferred |
| `#14` | flows | optional | deferred |
| `#15` | communities | optional | deferred |
| `#16` | read_only_suggestions | supporting | deferred |

These rows are not required for CRG graph parity and must not be read as Opcore epic dependencies.

## Fact Model Evidence

`packages/fixtures/graph-reference-evidence/golden-corpus.json` exercises the TypeScript graph corpus with 7 nodes and 6 edges: node kinds `File`, `Function`, and `Test`; edge kinds `CALLS`, `CONTAINS`, and `TESTED_BY`. `IMPORTS_FROM` is declared by the SQLite fixture but not exercised by the golden corpus. The current SQLite fixture also declares Rust-ready graph kinds and edges, but does not declare `Class` or `Type` as node kinds.

Export metadata is represented by the SQLite `nodes.is_exported` column and `idx_nodes_exported_name` index in `packages/fixtures/graph-reference-evidence/sqlite-fixtures.json`. The reference fixtures do not require `attributes.exported` as fixture evidence.

The graph-release receipt records direct SQLite reader evidence for status counts, edge counts, impact edges from file, search-by-name, and freshness metadata against `packages/fixtures/source-extraction/wave1/.lattice/graph/graph.db`.

## Replacement Claim

CRG graph parity is installed-receipt-backed: `cutover-receipt.json` runs `opcore graph` through `node_modules/.bin/opcore` while `environmentIsolation.opcoreBinOnly` and `environmentIsolation.oldBinsAbsent.{crg,cix,rox}` are all `true`.

The formal old-tool replacement claim remains withheld. `asp-dogfood-receipt.json` pins `oldToolReplacementClaimed: false`, records retained `current-tools:validate-changed` and `current-tools:validate-rust-graph` guardrails, and keeps inspect/edit gaps outside ASP dogfood authority. ACE wrappers remain on current tools until explicit downstream cutover work changes that.

Ledger state: CRG graph is `parity-demonstrated`; replacement claim is `replacement-claim-deferred`.

## Cross Dependencies

Rust graph parity rows are tracked by Opcore epic `#10` children: `#26` build/update/watch/status, `#27` query/search/impact/review-context/detect-changes, `#28` graph-backed validation, `#29` old-Rox comparison receipts, and `#30` retained-Rox retirement. This ledger references those rows and does not duplicate their acceptance evidence.

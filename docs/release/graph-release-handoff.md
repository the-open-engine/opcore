# Graph Release Handoff

Issue #17 graph-release gate receipt for #7, #28, and #29.

Full receipt: docs/release/graph-release-receipt.json
Full receipt SHA-256: 81ab958309c81ca98a855c392bb571f529ab64b0c02c37013d34d00b15a06c8d

| Issue | Checksummed Receipt Path | SHA-256 |
|-------|--------------------------|---------|
| #7 | docs/release/graph-release-receipt.payload.json | 5982e7cf18728410c48a708adec1fe94166594e054f484098eb37ed008a09c00 |
| #28 | docs/release/graph-release-receipt.payload.json | 5982e7cf18728410c48a708adec1fe94166594e054f484098eb37ed008a09c00 |
| #29 | docs/release/graph-release-receipt.payload.json | 5982e7cf18728410c48a708adec1fe94166594e054f484098eb37ed008a09c00 |

## Parent #4 Graph Scope

| Issue | Surface | Classification | Status | Release Blocking |
|-------|---------|----------------|--------|------------------|
| #13 | coverage | deferred | deferred | false |
| #14 | flows | optional | deferred | false |
| #15 | communities | optional | deferred | false |
| #16 | read_only_suggestions | supporting | deferred | false |

## Downstream Inspect Evidence

| Issue | Evidence | Status |
|-------|----------|--------|
| #101 | docs/release/inspect-signature-parity.md | read-only signature parity evidence for #4/#17 consumers |
| #102 | docs/release/inspect-implementations-parity.md | read-only implementation parity evidence for #4/#17 consumers |

License report: docs/release/license-report.md
Provenance receipt: docs/release/provenance-receipts.md

Rollback: keep ACE wrappers on current external tools if receipt regresses.
Maintainer note: these graph release checks must pass before publishing alpha artifacts.

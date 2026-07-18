# Graph Release Handoff

Issue #17 graph-release gate receipt for #7, #28, and #29.

Full receipt: docs/release/graph-release-receipt.json
Full receipt SHA-256: fee81c57608f2c63ddbfc23d53490760d03a5df49fe69e3849860db0599e852f

| Issue | Checksummed Receipt Path | SHA-256 |
|-------|--------------------------|---------|
| #7 | docs/release/graph-release-receipt.payload.json | 2ae48d67a1a908c5418f274c8d6d07843c131c9fc7f11ee1d0bd1f89fbcc628b |
| #28 | docs/release/graph-release-receipt.payload.json | 2ae48d67a1a908c5418f274c8d6d07843c131c9fc7f11ee1d0bd1f89fbcc628b |
| #29 | docs/release/graph-release-receipt.payload.json | 2ae48d67a1a908c5418f274c8d6d07843c131c9fc7f11ee1d0bd1f89fbcc628b |

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

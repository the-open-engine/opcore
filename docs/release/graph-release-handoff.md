# Graph Release Handoff

Issue #17 graph-release gate receipt for #7, #28, and #29.

Full receipt: docs/release/graph-release-receipt.json
Full receipt SHA-256: ac34db9f3c4bd9b36fd66bdf4884f3034b9a3bc56b019710903fc84748754b7b

| Issue | Checksummed Receipt Path | SHA-256 |
|-------|--------------------------|---------|
| #7 | docs/release/graph-release-receipt.payload.json | 601061a07beea0053c7a1d92ca227ce497ec502283f566766cfef2807d5a48b7 |
| #28 | docs/release/graph-release-receipt.payload.json | 601061a07beea0053c7a1d92ca227ce497ec502283f566766cfef2807d5a48b7 |
| #29 | docs/release/graph-release-receipt.payload.json | 601061a07beea0053c7a1d92ca227ce497ec502283f566766cfef2807d5a48b7 |

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

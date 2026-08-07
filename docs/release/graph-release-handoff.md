# Graph Release Handoff

Issue #17 graph-release gate receipt for #7, #28, and #29.

Full receipt: docs/release/graph-release-receipt.json
Full receipt SHA-256: dd92c74c58a5f4e039b36de397352e05fecd0a19a127f6a770a299e05bd1832f

| Issue | Checksummed Receipt Path | SHA-256 |
|-------|--------------------------|---------|
| #7 | docs/release/graph-release-receipt.payload.json | f6d68bdecc65a83e4e34e2d208f9158c5c83d06957e1da6ef90ab2444dd2891d |
| #28 | docs/release/graph-release-receipt.payload.json | f6d68bdecc65a83e4e34e2d208f9158c5c83d06957e1da6ef90ab2444dd2891d |
| #29 | docs/release/graph-release-receipt.payload.json | f6d68bdecc65a83e4e34e2d208f9158c5c83d06957e1da6ef90ab2444dd2891d |

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

Rollback: block release and repair Opcore self-validation if this receipt regresses.
Maintainer note: these graph release checks must pass before publishing alpha artifacts.

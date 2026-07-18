# Artifact Attestation

This repository keeps release artifact attestations executable for maintainers.

The release receipt gate proves package tarballs, descriptor references, native graph artifacts, license inventory, provenance, and secret/history hygiene.

Machine receipt: docs/release/release-receipt.json
Human summary: docs/release/release-receipt.summary.md
Graph input evidence: docs/release/graph-release-receipt.json

## Native Artifacts

| Platform | Binary | Binary SHA-256 | Checksum File |
|----------|--------|----------------|---------------|
| darwin-arm64 | node_modules/@the-open-engine/opcore-graph-core-darwin-arm64/opcore-graph-core | 72acf10de0ece619c3896943addfb0cc1b09dab22000b48a653b033224217bc8 | node_modules/@the-open-engine/opcore-graph-core-darwin-arm64/opcore-graph-core.sha256 |
| darwin-x64 | node_modules/@the-open-engine/opcore-graph-core-darwin-x64/opcore-graph-core | 1b72afa74d48b087c967cb01b39630ed3fa58b5a2895037a778eb5612ef73059 | node_modules/@the-open-engine/opcore-graph-core-darwin-x64/opcore-graph-core.sha256 |
| linux-x64 | node_modules/@the-open-engine/opcore-graph-core-linux-x64/opcore-graph-core | c3a771435a7a8172a9e5f0bb20b0d111453efc70901e95308094664f77e7bdf1 | node_modules/@the-open-engine/opcore-graph-core-linux-x64/opcore-graph-core.sha256 |

No package publishing happens in this gate.

## Cutover Gate

Issue #30 receipt: docs/release/cutover-receipt.json
Cutover receipt SHA-256: c72be0d79199505770c631b08201be09f8602e239e80c1ffa974e7f24d1cf32b
Installed command receipts: 28
Rust command receipts: 7
Python command receipts: 8
Current-tool guardrails retained: 2
Old-tool replacement claimed: false

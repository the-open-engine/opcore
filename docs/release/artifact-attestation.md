# Artifact Attestation

This repository keeps release artifact attestations executable for maintainers.

The release receipt gate proves package tarballs, descriptor references, native graph artifacts, license inventory, provenance, and secret/history hygiene.

Machine receipt: docs/release/release-receipt.json
Human summary: docs/release/release-receipt.summary.md
Graph input evidence: docs/release/graph-release-receipt.json

## Native Artifacts

| Platform | Binary | Binary SHA-256 | Checksum File |
|----------|--------|----------------|---------------|
| darwin-arm64 | opcore-graph-core | 01e834a5d0104ca9626b6ac78da1977bea87a62608abfdfba4bd3ea0ccea7508 | opcore-graph-core.sha256 |
| darwin-x64 | opcore-graph-core | 1b72afa74d48b087c967cb01b39630ed3fa58b5a2895037a778eb5612ef73059 | opcore-graph-core.sha256 |
| linux-x64 | opcore-graph-core | 70cb6d213d74594f337a67522c879b77767872dc4601063686f1abe70886127b | opcore-graph-core.sha256 |

No package publishing happens in this gate.

## Cutover Gate

Issue #30 receipt: docs/release/cutover-receipt.json
Cutover receipt SHA-256: bc46c1ebd4ee5b55a29ccee3614f5d8b5d6add60f3dc928543bd9e0869829000
Installed command receipts: 28
Rust command receipts: 7
Python command receipts: 8
Current-tool guardrails retained: 2
Old-tool replacement claimed: false

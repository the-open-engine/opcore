# Artifact Attestation

This repository keeps release artifact attestations executable for maintainers.

The release receipt gate proves package tarballs, descriptor references, native graph artifacts, license inventory, provenance, and secret/history hygiene.

Machine receipt: docs/release/release-receipt.json
Human summary: docs/release/release-receipt.summary.md
Graph input evidence: docs/release/graph-release-receipt.json

## Native Artifacts

| Platform | Binary | Binary SHA-256 | Checksum File |
|----------|--------|----------------|---------------|
| darwin-arm64 | opcore-graph-core | b4cdc0d9fbef2f2c67dc849cb80309f6e6edb8ab933dc8d4fb89b279f4b252e7 | opcore-graph-core.sha256 |
| darwin-x64 | opcore-graph-core | 1b72afa74d48b087c967cb01b39630ed3fa58b5a2895037a778eb5612ef73059 | opcore-graph-core.sha256 |
| linux-x64 | opcore-graph-core | 70cb6d213d74594f337a67522c879b77767872dc4601063686f1abe70886127b | opcore-graph-core.sha256 |

No package publishing happens in this gate.

## Cutover Gate

Issue #30 receipt: docs/release/cutover-receipt.json
Cutover receipt SHA-256: e584fd8649edd8001990e9dfd4607c0afb6d6f36ae27c367890eb93bdcdbad68
Installed command receipts: 28
Rust command receipts: 7
Python command receipts: 8
Current-tool guardrails retained: 2
Old-tool replacement claimed: false

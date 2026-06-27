# Artifact Attestation

This repository keeps release artifact attestations executable for maintainers.

The release receipt gate proves package tarballs, descriptor references, native graph artifacts, license inventory, provenance, and secret/history hygiene.

Machine receipt: docs/release/release-receipt.json
Human summary: docs/release/release-receipt.summary.md
Graph input evidence: docs/release/graph-release-receipt.json

## Native Artifacts

| Platform | Binary | Binary SHA-256 | Checksum File |
|----------|--------|----------------|---------------|
| darwin-arm64 | opcore-graph-core | 4a6eb4c6c4be15df3e126b725d83476a10665f36b7801cab0e1d5df64c70e82d | opcore-graph-core.sha256 |
| darwin-x64 | opcore-graph-core | 6652d43eec8f39e7c1b930b92e032eb268d1e4263454a89614e0d8299fc3b4e7 | opcore-graph-core.sha256 |
| linux-x64 | opcore-graph-core | 4654c6ba6383886e759fe3c805ec8c0df3b31d2e1db9d5c18626de6b2cfe758a | opcore-graph-core.sha256 |

No package publishing happens in this gate.

## Cutover Gate

Issue #30 receipt: docs/release/cutover-receipt.json
Cutover receipt SHA-256: 957417448d16ab802f950d7c721c0d841d27e270cac9d2016e2b22eceede4313
Installed command receipts: 28
Rust command receipts: 7
Python command receipts: 8
Current-tool guardrails retained: 2
Old-tool replacement claimed: false

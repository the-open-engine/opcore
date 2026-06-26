# Artifact Attestation

This repository keeps release artifact attestations executable for maintainers.

The release receipt gate proves package tarballs, descriptor references, native graph artifacts, license inventory, provenance, and secret/history hygiene.

Machine receipt: docs/release/release-receipt.json
Human summary: docs/release/release-receipt.summary.md
Graph input evidence: docs/release/graph-release-receipt.json

## Native Artifacts

| Platform | Binary | Binary SHA-256 | Checksum File |
|----------|--------|----------------|---------------|
| darwin-arm64 | lattice-graph-core | c4a086c73df1555cbc5536b46d55bd5fc266bad107c971c207bdf27931b864d6 | lattice-graph-core.sha256 |
| darwin-x64 | lattice-graph-core | 6652d43eec8f39e7c1b930b92e032eb268d1e4263454a89614e0d8299fc3b4e7 | lattice-graph-core.sha256 |
| linux-x64 | lattice-graph-core | 4654c6ba6383886e759fe3c805ec8c0df3b31d2e1db9d5c18626de6b2cfe758a | lattice-graph-core.sha256 |

No package publishing happens in this gate.

## Cutover Gate

Issue #30 receipt: docs/release/cutover-receipt.json
Cutover receipt SHA-256: d185aff7572c1f92ba3b50b0239d3bfcf4b34fee1c0f9cd3ab77f7420a2b9e33
Installed command receipts: 28

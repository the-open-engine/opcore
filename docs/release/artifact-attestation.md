# Artifact Attestation

This repository keeps release artifact attestations executable for maintainers.

The release receipt gate proves package tarballs, descriptor references, native graph artifacts, license inventory, provenance, and secret/history hygiene.

Machine receipt: docs/release/release-receipt.json
Human summary: docs/release/release-receipt.summary.md
Graph input evidence: docs/release/graph-release-receipt.json

## Native Artifacts

| Platform | Binary | Binary SHA-256 | Checksum File |
|----------|--------|----------------|---------------|
| darwin-arm64 | lattice-graph-core | d96817de80dc52e8825be402f7bc1ada4b6676e8b5e95e8f1819c3921c27a2d3 | lattice-graph-core.sha256 |
| darwin-x64 | lattice-graph-core | 6652d43eec8f39e7c1b930b92e032eb268d1e4263454a89614e0d8299fc3b4e7 | lattice-graph-core.sha256 |
| linux-x64 | lattice-graph-core | 4654c6ba6383886e759fe3c805ec8c0df3b31d2e1db9d5c18626de6b2cfe758a | lattice-graph-core.sha256 |

No package publishing happens in this gate.

## Cutover Gate

Issue #30 receipt: docs/release/cutover-receipt.json
Cutover receipt SHA-256: c64d7482f1801ab549514741e23b245735279de466e92fd61d5a8ce6b004fe40
Installed command receipts: 28

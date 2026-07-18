# Release Receipt Summary

Maintainer release receipt for the Opcore alpha package gate.

Machine receipt: docs/release/release-receipt.json
Machine receipt SHA-256: de47ce42ec42b04508b016d74f09cc7dc14eb08ee37d918f226490430eed4ff1

Canonical command groups: graph, inspect, edit, check, validate, status, doctor
Native graph artifacts: 3
Secret/history findings: 0
License unresolved count: 0

## Packages

| Package | Tarball | SHA-256 | Files |
|---------|---------|---------|-------|
| opcore | opcore-0.2.1.tgz | f3c4478eca2a9a1118b10bdabdfa009dfed0bdd8903312f06c42a8b60515b128 | 1250 |

## Reports

| Report | Status | SHA-256 | Summary |
|--------|--------|---------|---------|
| package-inspection | passed | n/a | npm pack package inspection passed |
| license | passed | bad9cae3266e2ad7b866eba223f05cedfcd8332d2e3c44656381e70e335e8773 | 119 production dependencies, 0 unresolved |
| provenance | passed | 0c0e0092c26d883fd6451f07d860ff8a3b9dd8f8179356b8659787f9da93597d | 695 files, 305 commits scanned |
| release-hygiene | passed | ab68c5abd9148dad24b344e54cd2a52ac19610a13ccf386b00fa853d8587547f | release hygiene check passed |
| graph-release | passed | fee81c57608f2c63ddbfc23d53490760d03a5df49fe69e3849860db0599e852f | graph release receipt #17 validated as input evidence |
| secret-history | passed | 7060c267c912e3156b87c646e3bc970eac1ac8bdd964cf0a794b83e6f1250614 | 692 files, 305 commits scanned |

Secret allowlist: docs/release/secret-scan-allowlist.json. Add entries only for reviewed false positives with path or commit scope, reviewer, reason, expiry, and optional fingerprint/kind narrowing.

Publish status: this gate packs and verifies artifacts only. Publishing remains manual.

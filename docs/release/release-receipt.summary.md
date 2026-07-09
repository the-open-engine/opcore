# Release Receipt Summary

Maintainer release receipt for the Opcore alpha package gate.

Machine receipt: docs/release/release-receipt.json
Machine receipt SHA-256: 9d22e13b6150e3cf433c56b4b86848d8b5d47a3839a5e478130fab2b477bcdd0

Canonical command groups: graph, inspect, edit, check, validate, status, doctor
Native graph artifacts: 3
Secret/history findings: 0
License unresolved count: 0

## Packages

| Package | Tarball | SHA-256 | Files |
|---------|---------|---------|-------|
| opcore | opcore-0.2.0.tgz | a5bc2d71695c2b3e8320f9dce88c7907d34e40af32eaa00793ae185386abd753 | 1055 |

## Reports

| Report | Status | SHA-256 | Summary |
|--------|--------|---------|---------|
| package-inspection | passed | n/a | npm pack package inspection passed |
| license | passed | f2d943a3e3c5caf7caf54988734554b9397aed2d7def5b08e4a9f11bdc8f433d | 118 production dependencies, 0 unresolved |
| provenance | passed | c13858047a9e80843b15bb89f0a1b97e6c3a5b83e0d3d6950da8c16623966f9c | 551 files, 248 commits scanned |
| release-hygiene | passed | ae55ec7440ea15bc8477a81010381c8dcb8e540b2f4fdf276c5883acb76159e1 | release hygiene check passed |
| graph-release | passed | 016134bf577c850906fcf7d28307a501024b01679d2ef63ae451655a368e5949 | graph release receipt #17 validated as input evidence |
| secret-history | passed | 7060c267c912e3156b87c646e3bc970eac1ac8bdd964cf0a794b83e6f1250614 | 548 files, 248 commits scanned |

Secret allowlist: docs/release/secret-scan-allowlist.json. Add entries only for reviewed false positives with path or commit scope, reviewer, reason, expiry, and optional fingerprint/kind narrowing.

Publish status: this gate packs and verifies artifacts only. Publishing remains manual.

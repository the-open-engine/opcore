# Release Receipt Summary

Maintainer release receipt for the Opcore alpha package gate.

Machine receipt: docs/release/release-receipt.json
Machine receipt SHA-256: c69bf194d306fd96325c72f89734e048f20552f7cd2390376c15d29650a45624

Canonical command groups: graph, inspect, edit, check, validate, status, doctor
Native graph artifacts: 3
Secret/history findings: 0
License unresolved count: 0

## Packages

| Package | Tarball | SHA-256 | Files |
|---------|---------|---------|-------|
| opcore | opcore-0.1.0.tgz | b2545dfa9e7aea2e86cd3deaff77210ffb74f429b0c0e5a8ed648198c2a1d27f | 1008 |

## Reports

| Report | Status | SHA-256 | Summary |
|--------|--------|---------|---------|
| package-inspection | passed | n/a | npm pack package inspection passed |
| license | passed | aaca97fbd7e61ac50129aa4c28768b7707001aada36e4bfa12518b86d45ca963 | 118 production dependencies, 0 unresolved |
| provenance | passed | 5637f7862aa4fa4e917583bf086343f5d35433dba17a03ebfb71e1b40a4259d0 | 528 files, 237 commits scanned |
| release-hygiene | passed | 1f280ff9d8fb9a107d6c2477cf8623b583f9874eb1856245bae329818366dc60 | release hygiene check passed |
| graph-release | passed | 262f8ead0eb405e3037dfcaacdf70f1cbb31890bb1221e45ee46ab82dfc02298 | graph release receipt #17 validated as input evidence |
| secret-history | passed | 7060c267c912e3156b87c646e3bc970eac1ac8bdd964cf0a794b83e6f1250614 | 525 files, 237 commits scanned |

Secret allowlist: docs/release/secret-scan-allowlist.json. Add entries only for reviewed false positives with path or commit scope, reviewer, reason, expiry, and optional fingerprint/kind narrowing.

Publish status: this gate packs and verifies artifacts only. Publishing remains manual.

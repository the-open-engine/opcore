# Release Receipt Summary

Maintainer release receipt for the Opcore alpha package gate.

Machine receipt: docs/release/release-receipt.json
Machine receipt SHA-256: ca3cd98456618c5de74194432754107dbf192fe5d04ea14a22f11cb92bc3b948

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
| provenance | passed | 426f897f1817c17b38a1adf04dda449d1e838413a287264f9c2dd5d07252cbc3 | 528 files, 238 commits scanned |
| release-hygiene | passed | a563254154ad3f007a1e61cdc067c37e542c521b19070660351a905628528ea8 | release hygiene check passed |
| graph-release | passed | 262f8ead0eb405e3037dfcaacdf70f1cbb31890bb1221e45ee46ab82dfc02298 | graph release receipt #17 validated as input evidence |
| secret-history | passed | 7060c267c912e3156b87c646e3bc970eac1ac8bdd964cf0a794b83e6f1250614 | 525 files, 238 commits scanned |

Secret allowlist: docs/release/secret-scan-allowlist.json. Add entries only for reviewed false positives with path or commit scope, reviewer, reason, expiry, and optional fingerprint/kind narrowing.

Publish status: this gate packs and verifies artifacts only. Publishing remains manual.

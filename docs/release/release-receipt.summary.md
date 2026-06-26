# Release Receipt Summary

Maintainer release receipt for the Lattice alpha package gate.

Machine receipt: docs/release/release-receipt.json
Machine receipt SHA-256: fd974af03edc4257ff63bb2279b5d97b542d0b0f9df5d7a04d5505198f0d9e80

Canonical command groups: graph, inspect, edit, check, validate, status, doctor
Native graph artifacts: 3
Secret/history findings: 0
License unresolved count: 0

## Packages

| Package | Tarball | SHA-256 | Files |
|---------|---------|---------|-------|
| @the-open-engine/opcore-contracts | the-open-engine-opcore-contracts-0.1.0-alpha.0.tgz | 66430e8e97551c4f545cec390f8c6e7f71f5b2943cf28494bd74ed2921d85c65 | 6 |
| @the-open-engine/opcore | the-open-engine-opcore-0.1.0-alpha.0.tgz | 79c33645c731bb80f2144de1bce854860e753e6456e06a9354924b2f28763a3b | 60 |
| @the-open-engine/opcore-graph | the-open-engine-opcore-graph-0.1.0-alpha.0.tgz | 99b3543204a1919e261820d4e70522643e96e690d5caf7586ef1e0ac95c7e1d7 | 17 |
| @the-open-engine/opcore-graph-core-darwin-arm64 | the-open-engine-opcore-graph-core-darwin-arm64-0.1.0-alpha.0.tgz | 37571b5b5af13f4103c3056f9c4846d4cf47bad31abfb937912d7ee900985151 | 5 |
| @the-open-engine/opcore-graph-core-darwin-x64 | the-open-engine-opcore-graph-core-darwin-x64-0.1.0-alpha.0.tgz | 368d60f892c079481dff9af24ef8ed3280a2ee3774ce3b464a245d99ef2c0e38 | 5 |
| @the-open-engine/opcore-graph-core-linux-x64 | the-open-engine-opcore-graph-core-linux-x64-0.1.0-alpha.0.tgz | 0257eec51dc2b82bba564f1aa528aeb09a890ed38c272639ddb7fe19225e4d48 | 5 |
| @the-open-engine/opcore-edit | the-open-engine-opcore-edit-0.1.0-alpha.0.tgz | 644a11cd599d33fedc3ba880b782d3256b2b7a9580c9863e34f50b7a0a98bfa8 | 71 |
| @the-open-engine/opcore-validation | the-open-engine-opcore-validation-0.1.0-alpha.0.tgz | 196a250ddb3fee9d1083f56b3f3a8a1e0319db52ee5a65a4730629e7a66d8549 | 38 |
| @the-open-engine/opcore-validation-rust | the-open-engine-opcore-validation-rust-0.1.0-alpha.0.tgz | d24a401104a220ab3951f6395edd4bd809a77a13661830be58391315dba77c40 | 53 |
| @the-open-engine/opcore-validation-typescript | the-open-engine-opcore-validation-typescript-0.1.0-alpha.0.tgz | 67fc29226b6509fd28290f6c86c75fdf6ba229c1599121baa3b5a01cb664a1af | 41 |
| @the-open-engine/opcore-asp-provider | the-open-engine-opcore-asp-provider-0.1.0-alpha.0.tgz | fab42dc3212f902a635e730760f82a9c604469eb980776bcc49cb8f5efa4849c | 28 |

## Reports

| Report | Status | SHA-256 | Summary |
|--------|--------|---------|---------|
| package-inspection | passed | n/a | npm pack package inspection passed |
| license | passed | 3515d1c895d2486baad3d81dcb0808ccbe236c25b7a5ef45061ded725048f607 | 11 production dependencies, 0 unresolved |
| provenance | passed | 965ac91c2aca9acdea53a6c7a9c97448eb6d694e27051b27a72e68a1883bd3d3 | 381 files, 39 commits scanned |
| release-hygiene | passed | 1878b39b8dd799a584770c167d63f7ff1cb49f8900002cf19768b63145922224 | release hygiene check passed |
| graph-release | passed | 81ab958309c81ca98a855c392bb571f529ab64b0c02c37013d34d00b15a06c8d | graph release receipt #17 validated as input evidence |
| secret-history | passed | 7060c267c912e3156b87c646e3bc970eac1ac8bdd964cf0a794b83e6f1250614 | 380 files, 39 commits scanned |

Secret allowlist: docs/release/secret-scan-allowlist.json. Add entries only for reviewed false positives with path or commit scope, reviewer, reason, expiry, and optional fingerprint/kind narrowing.

Publish status: this gate packs and verifies artifacts only. Publishing remains manual.

# Release Receipt Summary

Maintainer release receipt for the Lattice alpha package gate.

Machine receipt: docs/release/release-receipt.json
Machine receipt SHA-256: 160862774a1b6ece788b3163504721356cc417e049f2d524ed385f6e512f385d

Canonical command groups: graph, inspect, edit, check, validate, status, doctor
Native graph artifacts: 3
Secret/history findings: 0
License unresolved count: 0

## Packages

| Package | Tarball | SHA-256 | Files |
|---------|---------|---------|-------|
| @the-open-engine/opcore-contracts | the-open-engine-opcore-contracts-0.1.0-alpha.0.tgz | 16b4587170166d0f8b02d5d84df87ee0274bd28ffba985cd5616d64c92169795 | 6 |
| @the-open-engine/opcore | the-open-engine-opcore-0.1.0-alpha.0.tgz | ffdbe17068ba144c525721eca0548ca366d6fadbe625b8ae44843f770e758fb4 | 60 |
| @the-open-engine/opcore-graph | the-open-engine-opcore-graph-0.1.0-alpha.0.tgz | 99b3543204a1919e261820d4e70522643e96e690d5caf7586ef1e0ac95c7e1d7 | 17 |
| @the-open-engine/opcore-graph-core-darwin-arm64 | the-open-engine-opcore-graph-core-darwin-arm64-0.1.0-alpha.0.tgz | e761ea2dbca97db906d93b0cfe4b85c4aa721681f82f6f0d3642c423e3ea6a90 | 5 |
| @the-open-engine/opcore-graph-core-darwin-x64 | the-open-engine-opcore-graph-core-darwin-x64-0.1.0-alpha.0.tgz | 368d60f892c079481dff9af24ef8ed3280a2ee3774ce3b464a245d99ef2c0e38 | 5 |
| @the-open-engine/opcore-graph-core-linux-x64 | the-open-engine-opcore-graph-core-linux-x64-0.1.0-alpha.0.tgz | 0257eec51dc2b82bba564f1aa528aeb09a890ed38c272639ddb7fe19225e4d48 | 5 |
| @the-open-engine/opcore-edit | the-open-engine-opcore-edit-0.1.0-alpha.0.tgz | 644a11cd599d33fedc3ba880b782d3256b2b7a9580c9863e34f50b7a0a98bfa8 | 71 |
| @the-open-engine/opcore-validation | the-open-engine-opcore-validation-0.1.0-alpha.0.tgz | 196a250ddb3fee9d1083f56b3f3a8a1e0319db52ee5a65a4730629e7a66d8549 | 38 |
| @the-open-engine/opcore-validation-rust | the-open-engine-opcore-validation-rust-0.1.0-alpha.0.tgz | 62fbf3bd851a41cafff48c209f2da006215f2e8ad3218d66483e0ec1090d419b | 53 |
| @the-open-engine/opcore-validation-typescript | the-open-engine-opcore-validation-typescript-0.1.0-alpha.0.tgz | 67fc29226b6509fd28290f6c86c75fdf6ba229c1599121baa3b5a01cb664a1af | 41 |
| @the-open-engine/opcore-asp-provider | the-open-engine-opcore-asp-provider-0.1.0-alpha.0.tgz | fab42dc3212f902a635e730760f82a9c604469eb980776bcc49cb8f5efa4849c | 28 |

## Reports

| Report | Status | SHA-256 | Summary |
|--------|--------|---------|---------|
| package-inspection | passed | n/a | npm pack package inspection passed |
| license | passed | 3515d1c895d2486baad3d81dcb0808ccbe236c25b7a5ef45061ded725048f607 | 11 production dependencies, 0 unresolved |
| provenance | passed | cfef926cf08a5fbc51d5faf2012a4191f0cb9dfcb9d16be093c4578fa1f98b64 | 394 files, 53 commits scanned |
| release-hygiene | passed | 797cf37b97fc2d93b8ded9a379b63d3d496e1895ec376a9c81bc74f9e1e63bbb | release hygiene check passed |
| graph-release | passed | 81ab958309c81ca98a855c392bb571f529ab64b0c02c37013d34d00b15a06c8d | graph release receipt #17 validated as input evidence |
| secret-history | passed | 7060c267c912e3156b87c646e3bc970eac1ac8bdd964cf0a794b83e6f1250614 | 393 files, 53 commits scanned |

Secret allowlist: docs/release/secret-scan-allowlist.json. Add entries only for reviewed false positives with path or commit scope, reviewer, reason, expiry, and optional fingerprint/kind narrowing.

Publish status: this gate packs and verifies artifacts only. Publishing remains manual.

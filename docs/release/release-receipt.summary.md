# Release Receipt Summary

Maintainer release receipt for the Opcore alpha package gate.

Machine receipt: docs/release/release-receipt.json
Machine receipt SHA-256: 3acb25c5016e4e77ca1622d5ae429fe4c12a5a4e403bc753d921a53ab3190e22

Canonical command groups: graph, inspect, edit, check, validate, status, doctor
Native graph artifacts: 3
Secret/history findings: 0
License unresolved count: 0

## Packages

| Package | Tarball | SHA-256 | Files |
|---------|---------|---------|-------|
| @the-open-engine/opcore-contracts | the-open-engine-opcore-contracts-0.1.0-alpha.0.tgz | 2b860d741effc2e6cd42b80d36c5641434ed455c63891aca9a39bc718322fab5 | 6 |
| @the-open-engine/opcore | the-open-engine-opcore-0.1.0-alpha.0.tgz | 509e6b0101ed4fb1d52eec12e5939bfc90f04e0437df6f7938a1b9215e1a6099 | 96 |
| @the-open-engine/opcore-graph | the-open-engine-opcore-graph-0.1.0-alpha.0.tgz | ef50966e77426a4b25cb172be36da1a4334780b9cb58f634fd6842f6314edf3d | 17 |
| @the-open-engine/opcore-graph-core-darwin-arm64 | the-open-engine-opcore-graph-core-darwin-arm64-0.1.0-alpha.0.tgz | e69d04a64799dfb5c51187a0150d053ee52a022dadbce60a260f2fc07d652238 | 5 |
| @the-open-engine/opcore-graph-core-darwin-x64 | the-open-engine-opcore-graph-core-darwin-x64-0.1.0-alpha.0.tgz | dcce542aca22af703b08641bb653b39d8540e391e91da36e8788d52d36e47de5 | 5 |
| @the-open-engine/opcore-graph-core-linux-x64 | the-open-engine-opcore-graph-core-linux-x64-0.1.0-alpha.0.tgz | 696ce89206a493c71d04afa8581eeb0440baf4d3908def0697be5ee433709a9d | 5 |
| @the-open-engine/opcore-edit | the-open-engine-opcore-edit-0.1.0-alpha.0.tgz | ba7341935cc034d0a38b381e7a7f6b4c5273d1cf8f38548fb1b1b8d68b10a143 | 71 |
| @the-open-engine/opcore-validation | the-open-engine-opcore-validation-0.1.0-alpha.0.tgz | fa7b15fec5259bf83973e3179fc1155155997bb697f4fe6753208759da461885 | 38 |
| @the-open-engine/opcore-validation-clone | the-open-engine-opcore-validation-clone-0.1.0-alpha.0.tgz | e0c06416a582e304e4d9b6a7980fd7da06a3eb543cc00561f0a75c9852d26144 | 17 |
| @the-open-engine/opcore-validation-docs | the-open-engine-opcore-validation-docs-0.1.0-alpha.0.tgz | 63fd39f5802100e44459ff01f289c355faede6254fab53f400540702adab65d3 | 26 |
| @the-open-engine/opcore-validation-python | the-open-engine-opcore-validation-python-0.1.0-alpha.0.tgz | 50f94e3a345de4fb80ea6b744bbcee3cd14ac7a48aa2972d91aaae9212b9a518 | 44 |
| @the-open-engine/opcore-validation-rust | the-open-engine-opcore-validation-rust-0.1.0-alpha.0.tgz | ed810e30f0b75db15c1e6923d583f24e3e30c4f18a17f3de6e24ce7d7799547f | 59 |
| @the-open-engine/opcore-validation-typescript | the-open-engine-opcore-validation-typescript-0.1.0-alpha.0.tgz | 7a042dc8def2ef4b0f45ae04d3c93200da447b529abd8bce51ca8052d2487a90 | 56 |
| @the-open-engine/opcore-asp-provider | the-open-engine-opcore-asp-provider-0.1.0-alpha.0.tgz | 91cf08e820f6ee16dd2487c4e700bf0dd2d189578cec5f59fdd9c4526cc012ac | 28 |
| @the-open-engine/opcore-fixtures | the-open-engine-opcore-fixtures-0.1.0-alpha.0.tgz | 9de4646a25c454568bf8bd98efe15cc02d7b6765e5d643a6baeaf38f98f68e30 | 71 |

## Reports

| Report | Status | SHA-256 | Summary |
|--------|--------|---------|---------|
| package-inspection | passed | n/a | npm pack package inspection passed |
| license | passed | 16bf67acce4c0ae91a9575250e3b71a614d2a91f342ce8aeda5fcb6dbe4eae49 | 118 production dependencies, 0 unresolved |
| provenance | passed | 2608c0ac9b1a2b42ae390ba180818acd7e5af4cc06a3ef61084cd839c4fcd1c9 | 508 files, 210 commits scanned |
| release-hygiene | passed | 48f61e7a6bea6afb7735d0256e1501b283162f4537b125ebd59d2a52f6b882eb | release hygiene check passed |
| graph-release | passed | cfa3d2be19748adeaeb0484630b07c0ab869548fb328c85ada4a97f87e17e561 | graph release receipt #17 validated as input evidence |
| secret-history | passed | 7060c267c912e3156b87c646e3bc970eac1ac8bdd964cf0a794b83e6f1250614 | 507 files, 210 commits scanned |

Secret allowlist: docs/release/secret-scan-allowlist.json. Add entries only for reviewed false positives with path or commit scope, reviewer, reason, expiry, and optional fingerprint/kind narrowing.

Publish status: this gate packs and verifies artifacts only. Publishing remains manual.

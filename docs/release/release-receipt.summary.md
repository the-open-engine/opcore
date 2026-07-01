# Release Receipt Summary

Maintainer release receipt for the Opcore alpha package gate.

Machine receipt: docs/release/release-receipt.json
Machine receipt SHA-256: 869f3a8a269a12262d942e43acdb86095b4fb7b58964fb29e0a345873e6e60d8

Canonical command groups: graph, inspect, edit, check, validate, status, doctor
Native graph artifacts: 3
Secret/history findings: 0
License unresolved count: 0

## Packages

| Package | Tarball | SHA-256 | Files |
|---------|---------|---------|-------|
| @the-open-engine/opcore-contracts | the-open-engine-opcore-contracts-0.1.0.tgz | 539f51e98c2b6a603c5daf67af4bf96bd413c2bc8e94f7a71d407c0fd3c247ca | 6 |
| @the-open-engine/opcore | the-open-engine-opcore-0.1.0.tgz | 4fb4d2fd18fb093e6b9a7b283adcd29861bab20e2b8fcaa4113559f3a1b54a21 | 111 |
| @the-open-engine/opcore-graph | the-open-engine-opcore-graph-0.1.0.tgz | 9b930eeb81a8f1eef1db8a3e499909344697a0a92333a2e5e8fa0018dfb7ae3a | 17 |
| @the-open-engine/opcore-graph-core-darwin-arm64 | the-open-engine-opcore-graph-core-darwin-arm64-0.1.0.tgz | bddba8eb93e40e3123f67f2c37c5f006a679edffd2626907e10336bf575cf16b | 5 |
| @the-open-engine/opcore-graph-core-darwin-x64 | the-open-engine-opcore-graph-core-darwin-x64-0.1.0.tgz | ab9fc93007193945fcab164dd650ab767660bdf24a059bf2a51d7f1ab880aec6 | 5 |
| @the-open-engine/opcore-graph-core-linux-x64 | the-open-engine-opcore-graph-core-linux-x64-0.1.0.tgz | 9bea900b35fe09c54c3ee3b70e9e0d4949065fe508589a8cd2ed6e406043f811 | 5 |
| @the-open-engine/opcore-edit | the-open-engine-opcore-edit-0.1.0.tgz | 92eb8ccb48409cc60514e4109199da0491bc1409dbdc24a70792da852cef154a | 71 |
| @the-open-engine/opcore-validation | the-open-engine-opcore-validation-0.1.0.tgz | 08007efd4ad00dc0558df13ec67dc82eb7cb74ac86dd50b9feb36ed3030bfece | 38 |
| @the-open-engine/opcore-validation-clone | the-open-engine-opcore-validation-clone-0.1.0.tgz | 299096e6256ce7b621a313ff543a0103a92e34e9a21df080decd642203c62575 | 17 |
| @the-open-engine/opcore-validation-docs | the-open-engine-opcore-validation-docs-0.1.0.tgz | fae3a4ea7be79282f9f38d059dc4937f50eeffefc739be12644f4f103ce8a2f6 | 26 |
| @the-open-engine/opcore-validation-python | the-open-engine-opcore-validation-python-0.1.0.tgz | ac4a2b6928e8fc726ad997ff6cf080c752267211dc0be318b60418ed0c4770d9 | 44 |
| @the-open-engine/opcore-validation-rust | the-open-engine-opcore-validation-rust-0.1.0.tgz | f18bfbebbe5d605e79eabe8fe9e53fb0968e5dda08a2d81be4e7023e4e7bbfbb | 59 |
| @the-open-engine/opcore-validation-typescript | the-open-engine-opcore-validation-typescript-0.1.0.tgz | 74c4c325d24301259352b94f9a683e3c5fe6c334ca041a06b275ddcd2671b2ae | 56 |
| @the-open-engine/opcore-asp-provider | the-open-engine-opcore-asp-provider-0.1.0.tgz | ab5dff2c9af402852a9343859555d8da75b354fba1e3e40075ede893034e7190 | 28 |
| @the-open-engine/opcore-fixtures | the-open-engine-opcore-fixtures-0.1.0.tgz | 4fe622714ad0552d4f8d1aafb71d374964902604206ea0d183238003c43d9135 | 71 |

## Reports

| Report | Status | SHA-256 | Summary |
|--------|--------|---------|---------|
| package-inspection | passed | n/a | npm pack package inspection passed |
| license | passed | 48eebdb4dd65209b21812686eebf113683365316ce69fdfb586dcecac21a400b | 118 production dependencies, 0 unresolved |
| provenance | passed | e53e922af7b50eaad70372c328d981fa4df5941b297f61b2aa4c9f359b1ca20f | 519 files, 217 commits scanned |
| release-hygiene | passed | 71a9e15784b858f356f1d549f7f7768cc8bbde5f6efa5ea9666c42948d56dcc3 | release hygiene check passed |
| graph-release | passed | 262f8ead0eb405e3037dfcaacdf70f1cbb31890bb1221e45ee46ab82dfc02298 | graph release receipt #17 validated as input evidence |
| secret-history | passed | 7060c267c912e3156b87c646e3bc970eac1ac8bdd964cf0a794b83e6f1250614 | 516 files, 217 commits scanned |

Secret allowlist: docs/release/secret-scan-allowlist.json. Add entries only for reviewed false positives with path or commit scope, reviewer, reason, expiry, and optional fingerprint/kind narrowing.

Publish status: this gate packs and verifies artifacts only. Publishing remains manual.

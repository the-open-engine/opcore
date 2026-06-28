# Release Receipt Summary

Maintainer release receipt for the Opcore alpha package gate.

Machine receipt: docs/release/release-receipt.json
Machine receipt SHA-256: 0c1920dfcf68fe3ff1092c7bf3f786e3ce6917e9b0ce69bf9a4564f97e4ad381

Canonical command groups: graph, inspect, edit, check, validate, status, doctor
Native graph artifacts: 3
Secret/history findings: 0
License unresolved count: 0

## Packages

| Package | Tarball | SHA-256 | Files |
|---------|---------|---------|-------|
| @the-open-engine/opcore-contracts | the-open-engine-opcore-contracts-0.1.0-alpha.0.tgz | ecdc22c596e13fb68cd843cf80579c6556d4704c890e059b0bee0c15c57a4f7c | 6 |
| @the-open-engine/opcore | the-open-engine-opcore-0.1.0-alpha.0.tgz | 41bdf5f505457c30cd888b55664bf50c3bfa79f10a9ca660601af4fcca3ddad9 | 96 |
| @the-open-engine/opcore-graph | the-open-engine-opcore-graph-0.1.0-alpha.0.tgz | ef50966e77426a4b25cb172be36da1a4334780b9cb58f634fd6842f6314edf3d | 17 |
| @the-open-engine/opcore-graph-core-darwin-arm64 | the-open-engine-opcore-graph-core-darwin-arm64-0.1.0-alpha.0.tgz | e69d04a64799dfb5c51187a0150d053ee52a022dadbce60a260f2fc07d652238 | 5 |
| @the-open-engine/opcore-graph-core-darwin-x64 | the-open-engine-opcore-graph-core-darwin-x64-0.1.0-alpha.0.tgz | dcce542aca22af703b08641bb653b39d8540e391e91da36e8788d52d36e47de5 | 5 |
| @the-open-engine/opcore-graph-core-linux-x64 | the-open-engine-opcore-graph-core-linux-x64-0.1.0-alpha.0.tgz | 696ce89206a493c71d04afa8581eeb0440baf4d3908def0697be5ee433709a9d | 5 |
| @the-open-engine/opcore-edit | the-open-engine-opcore-edit-0.1.0-alpha.0.tgz | 669da31883822dea02ee957ffda4f8a4994c7499ff60f82dc3bf944bc2b152b9 | 71 |
| @the-open-engine/opcore-validation | the-open-engine-opcore-validation-0.1.0-alpha.0.tgz | fa7b15fec5259bf83973e3179fc1155155997bb697f4fe6753208759da461885 | 38 |
| @the-open-engine/opcore-validation-clone | the-open-engine-opcore-validation-clone-0.1.0-alpha.0.tgz | e0c06416a582e304e4d9b6a7980fd7da06a3eb543cc00561f0a75c9852d26144 | 17 |
| @the-open-engine/opcore-validation-python | the-open-engine-opcore-validation-python-0.1.0-alpha.0.tgz | 50f94e3a345de4fb80ea6b744bbcee3cd14ac7a48aa2972d91aaae9212b9a518 | 44 |
| @the-open-engine/opcore-validation-rust | the-open-engine-opcore-validation-rust-0.1.0-alpha.0.tgz | ed810e30f0b75db15c1e6923d583f24e3e30c4f18a17f3de6e24ce7d7799547f | 59 |
| @the-open-engine/opcore-validation-typescript | the-open-engine-opcore-validation-typescript-0.1.0-alpha.0.tgz | 7a042dc8def2ef4b0f45ae04d3c93200da447b529abd8bce51ca8052d2487a90 | 56 |
| @the-open-engine/opcore-asp-provider | the-open-engine-opcore-asp-provider-0.1.0-alpha.0.tgz | 87013f30770349f1db125bc3379c81fc57dd6f445696a29bfeeb2839ac834403 | 28 |
| @the-open-engine/opcore-fixtures | the-open-engine-opcore-fixtures-0.1.0-alpha.0.tgz | 9de4646a25c454568bf8bd98efe15cc02d7b6765e5d643a6baeaf38f98f68e30 | 71 |

## Reports

| Report | Status | SHA-256 | Summary |
|--------|--------|---------|---------|
| package-inspection | passed | n/a | npm pack package inspection passed |
| license | passed | be6f578d8d47e4afb3b9116709dd7c778fee3eff47f0d09eafacae225197ce03 | 118 production dependencies, 0 unresolved |
| provenance | passed | 0d54de5ce395f15375af18e8790ccf8badcaa7316e3afb7a756f41646d18be44 | 494 files, 207 commits scanned |
| release-hygiene | passed | 432f560fc17b0fee9fd3cd18f4516b25bafc6455bf348f81d183942b823574b7 | release hygiene check passed |
| graph-release | passed | cfa3d2be19748adeaeb0484630b07c0ab869548fb328c85ada4a97f87e17e561 | graph release receipt #17 validated as input evidence |
| secret-history | passed | 7060c267c912e3156b87c646e3bc970eac1ac8bdd964cf0a794b83e6f1250614 | 493 files, 207 commits scanned |

Secret allowlist: docs/release/secret-scan-allowlist.json. Add entries only for reviewed false positives with path or commit scope, reviewer, reason, expiry, and optional fingerprint/kind narrowing.

Publish status: this gate packs and verifies artifacts only. Publishing remains manual.

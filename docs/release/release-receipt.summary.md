# Release Receipt Summary

Maintainer release receipt for the Opcore alpha package gate.

Machine receipt: docs/release/release-receipt.json
Machine receipt SHA-256: 30550e5b0e604c2cf93b30476953693097f3a03aaaa907e4ebdf506bb7c2ea31

Canonical command groups: graph, inspect, edit, check, validate, status, doctor
Native graph artifacts: 3
Secret/history findings: 0
License unresolved count: 0

## Packages

| Package | Tarball | SHA-256 | Files |
|---------|---------|---------|-------|
| @the-open-engine/opcore-contracts | the-open-engine-opcore-contracts-0.1.0-alpha.0.tgz | 49e11a2ecbbd9b321331abce09989eaa7b83b4a59c8a605e4b282d9941d3c0e3 | 6 |
| @the-open-engine/opcore | the-open-engine-opcore-0.1.0-alpha.0.tgz | 82ef2f3742b34955f56686d0dfa027fb51a96acbfedf219497f8033d1dd71e46 | 63 |
| @the-open-engine/opcore-graph | the-open-engine-opcore-graph-0.1.0-alpha.0.tgz | a8d02e39327a4e690c75bbc43daa8c5fa2437d55ae4e8b699a0699df2be1392f | 17 |
| @the-open-engine/opcore-graph-core-darwin-arm64 | the-open-engine-opcore-graph-core-darwin-arm64-0.1.0-alpha.0.tgz | 9f1256e95d97946e82169010a44d15507c27cdf78caaff8b8e49d9fbfb61e8ec | 5 |
| @the-open-engine/opcore-graph-core-darwin-x64 | the-open-engine-opcore-graph-core-darwin-x64-0.1.0-alpha.0.tgz | 22a5b1f23369b62def84e3b143d169c82bedca7b5f2e3632390a6d2cf0a5e9b7 | 5 |
| @the-open-engine/opcore-graph-core-linux-x64 | the-open-engine-opcore-graph-core-linux-x64-0.1.0-alpha.0.tgz | a72a3954870f4cdca25272f75ada85a83758361cca9df28559008f67a5ceac78 | 5 |
| @the-open-engine/opcore-edit | the-open-engine-opcore-edit-0.1.0-alpha.0.tgz | 7900a3a25d06b5855201be1bb1157fbe3d9c5b95afe77e2501d8e4d9d6deafe0 | 71 |
| @the-open-engine/opcore-validation | the-open-engine-opcore-validation-0.1.0-alpha.0.tgz | 90683d459be2129e57f52df9da29b5eb3b9f95d4bb894908f4878846665e4da4 | 38 |
| @the-open-engine/opcore-validation-python | the-open-engine-opcore-validation-python-0.1.0-alpha.0.tgz | 50f94e3a345de4fb80ea6b744bbcee3cd14ac7a48aa2972d91aaae9212b9a518 | 44 |
| @the-open-engine/opcore-validation-rust | the-open-engine-opcore-validation-rust-0.1.0-alpha.0.tgz | 18429fa20e181d1daefd327053802bea2a88471f84b6b53401d75c96893367d7 | 56 |
| @the-open-engine/opcore-validation-typescript | the-open-engine-opcore-validation-typescript-0.1.0-alpha.0.tgz | 67fc29226b6509fd28290f6c86c75fdf6ba229c1599121baa3b5a01cb664a1af | 41 |
| @the-open-engine/opcore-asp-provider | the-open-engine-opcore-asp-provider-0.1.0-alpha.0.tgz | ca09b53ec81c6f3a58c9d753918cbd85b65e6c9dd7124f55dc00f46cd7b4a7b4 | 28 |
| @the-open-engine/opcore-fixtures | the-open-engine-opcore-fixtures-0.1.0-alpha.0.tgz | 9af1b8cf9d9715db778ff5046c18d63103aa1fbba0e55c3ac660dee56abf5f82 | 71 |

## Reports

| Report | Status | SHA-256 | Summary |
|--------|--------|---------|---------|
| package-inspection | passed | n/a | npm pack package inspection passed |
| license | passed | 72d7f1f2fcf3c4fa8f57bfc56c34a1b7db1b1f6951665aef8ba871efc04df23d | 11 production dependencies, 0 unresolved |
| provenance | passed | 61924843eb487b0e9f24214a1ec901eba2830fde35ac72fde19e399bf089c40a | 450 files, 119 commits scanned |
| release-hygiene | passed | c1424f688ac1ccda1ab1f518dca8d0494eced64cd4d2c96d8f1bd10483be1ff8 | release hygiene check passed |
| graph-release | passed | ac34db9f3c4bd9b36fd66bdf4884f3034b9a3bc56b019710903fc84748754b7b | graph release receipt #17 validated as input evidence |
| secret-history | passed | 7060c267c912e3156b87c646e3bc970eac1ac8bdd964cf0a794b83e6f1250614 | 449 files, 119 commits scanned |

Secret allowlist: docs/release/secret-scan-allowlist.json. Add entries only for reviewed false positives with path or commit scope, reviewer, reason, expiry, and optional fingerprint/kind narrowing.

Publish status: this gate packs and verifies artifacts only. Publishing remains manual.

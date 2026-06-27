# Release Receipt Summary

Maintainer release receipt for the Opcore alpha package gate.

Machine receipt: docs/release/release-receipt.json
Machine receipt SHA-256: da1eec1458addb82f27e218b78f8f91d19c13ad4a7cfd42630d49c1693651fe6

Canonical command groups: graph, inspect, edit, check, validate, status, doctor
Native graph artifacts: 3
Secret/history findings: 0
License unresolved count: 0

## Packages

| Package | Tarball | SHA-256 | Files |
|---------|---------|---------|-------|
| @the-open-engine/opcore-contracts | the-open-engine-opcore-contracts-0.1.0-alpha.0.tgz | c784fdc3947b8051242c324e580597bc46704e8dd9b443e2f754c4b52da2119c | 6 |
| @the-open-engine/opcore | the-open-engine-opcore-0.1.0-alpha.0.tgz | 42f6dc0bd2d9653911825fada8dc604f5cab37fca58f64e493ad7992ad8c153d | 63 |
| @the-open-engine/opcore-graph | the-open-engine-opcore-graph-0.1.0-alpha.0.tgz | a8d02e39327a4e690c75bbc43daa8c5fa2437d55ae4e8b699a0699df2be1392f | 17 |
| @the-open-engine/opcore-graph-core-darwin-arm64 | the-open-engine-opcore-graph-core-darwin-arm64-0.1.0-alpha.0.tgz | 2128503941ef4cf882c3e0a6663722180e7ca377ec7e16bf8f2207e10aecc328 | 5 |
| @the-open-engine/opcore-graph-core-darwin-x64 | the-open-engine-opcore-graph-core-darwin-x64-0.1.0-alpha.0.tgz | 22a5b1f23369b62def84e3b143d169c82bedca7b5f2e3632390a6d2cf0a5e9b7 | 5 |
| @the-open-engine/opcore-graph-core-linux-x64 | the-open-engine-opcore-graph-core-linux-x64-0.1.0-alpha.0.tgz | a72a3954870f4cdca25272f75ada85a83758361cca9df28559008f67a5ceac78 | 5 |
| @the-open-engine/opcore-edit | the-open-engine-opcore-edit-0.1.0-alpha.0.tgz | 7900a3a25d06b5855201be1bb1157fbe3d9c5b95afe77e2501d8e4d9d6deafe0 | 71 |
| @the-open-engine/opcore-validation | the-open-engine-opcore-validation-0.1.0-alpha.0.tgz | 2bf785270a5365d714b396fd694fbc8b9ff2f1ce1bb10befd803812b20a1b988 | 38 |
| @the-open-engine/opcore-validation-python | the-open-engine-opcore-validation-python-0.1.0-alpha.0.tgz | 50f94e3a345de4fb80ea6b744bbcee3cd14ac7a48aa2972d91aaae9212b9a518 | 44 |
| @the-open-engine/opcore-validation-rust | the-open-engine-opcore-validation-rust-0.1.0-alpha.0.tgz | 18429fa20e181d1daefd327053802bea2a88471f84b6b53401d75c96893367d7 | 56 |
| @the-open-engine/opcore-validation-typescript | the-open-engine-opcore-validation-typescript-0.1.0-alpha.0.tgz | 67fc29226b6509fd28290f6c86c75fdf6ba229c1599121baa3b5a01cb664a1af | 41 |
| @the-open-engine/opcore-asp-provider | the-open-engine-opcore-asp-provider-0.1.0-alpha.0.tgz | ca09b53ec81c6f3a58c9d753918cbd85b65e6c9dd7124f55dc00f46cd7b4a7b4 | 28 |
| @the-open-engine/opcore-fixtures | the-open-engine-opcore-fixtures-0.1.0-alpha.0.tgz | 9af1b8cf9d9715db778ff5046c18d63103aa1fbba0e55c3ac660dee56abf5f82 | 71 |

## Reports

| Report | Status | SHA-256 | Summary |
|--------|--------|---------|---------|
| package-inspection | passed | n/a | npm pack package inspection passed |
| license | passed | b401a91903b674d8feca00af7fcdf3e5f919e03622521c54f8cc742dcafd7ca6 | 118 production dependencies, 0 unresolved |
| provenance | passed | 51e7b93ff4e04311db3591db8ca1bb613636ddaac1b4f0e6ca7f7a79486df68a | 467 files, 137 commits scanned |
| release-hygiene | passed | 65a36dafb2f996c0900720e66f726b579776d61329e6b3bbba5a4563d481bda1 | release hygiene check passed |
| graph-release | passed | cfa3d2be19748adeaeb0484630b07c0ab869548fb328c85ada4a97f87e17e561 | graph release receipt #17 validated as input evidence |
| secret-history | passed | 7060c267c912e3156b87c646e3bc970eac1ac8bdd964cf0a794b83e6f1250614 | 466 files, 137 commits scanned |

Secret allowlist: docs/release/secret-scan-allowlist.json. Add entries only for reviewed false positives with path or commit scope, reviewer, reason, expiry, and optional fingerprint/kind narrowing.

Publish status: this gate packs and verifies artifacts only. Publishing remains manual.

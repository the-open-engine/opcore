# Release Receipt Summary

Maintainer release receipt for the Lattice alpha package gate.

Machine receipt: docs/release/release-receipt.json
Machine receipt SHA-256: f31f850aac344cbb9e4e64a98ca47f367acafdc01104629b7a8d9789d13bb025

Canonical command groups: graph, inspect, edit, check, validate, status, doctor
Native graph artifacts: 3
Secret/history findings: 0
License unresolved count: 0

## Packages

| Package | Tarball | SHA-256 | Files |
|---------|---------|---------|-------|
| @the-open-engine/opcore-contracts | the-open-engine-opcore-contracts-0.1.0-alpha.0.tgz | 4c9f21ea2a09097e74dcf10ce9e09e800672bdedf1c69883c88ce38265f35170 | 6 |
| @the-open-engine/opcore | the-open-engine-opcore-0.1.0-alpha.0.tgz | 61871b8f813396d98f422be479319010cb6da0ab5b4cd7114b6529f7d49be7b3 | 60 |
| @the-open-engine/opcore-graph | the-open-engine-opcore-graph-0.1.0-alpha.0.tgz | 99b3543204a1919e261820d4e70522643e96e690d5caf7586ef1e0ac95c7e1d7 | 17 |
| @the-open-engine/opcore-graph-core-darwin-arm64 | the-open-engine-opcore-graph-core-darwin-arm64-0.1.0-alpha.0.tgz | 007edb46750c3586b41cb31a33e0ef285b7dea401b2065b27f68bf17be56a349 | 5 |
| @the-open-engine/opcore-graph-core-darwin-x64 | the-open-engine-opcore-graph-core-darwin-x64-0.1.0-alpha.0.tgz | 368d60f892c079481dff9af24ef8ed3280a2ee3774ce3b464a245d99ef2c0e38 | 5 |
| @the-open-engine/opcore-graph-core-linux-x64 | the-open-engine-opcore-graph-core-linux-x64-0.1.0-alpha.0.tgz | 0257eec51dc2b82bba564f1aa528aeb09a890ed38c272639ddb7fe19225e4d48 | 5 |
| @the-open-engine/opcore-edit | the-open-engine-opcore-edit-0.1.0-alpha.0.tgz | 644a11cd599d33fedc3ba880b782d3256b2b7a9580c9863e34f50b7a0a98bfa8 | 71 |
| @the-open-engine/opcore-validation | the-open-engine-opcore-validation-0.1.0-alpha.0.tgz | 196a250ddb3fee9d1083f56b3f3a8a1e0319db52ee5a65a4730629e7a66d8549 | 38 |
| @the-open-engine/opcore-validation-rust | the-open-engine-opcore-validation-rust-0.1.0-alpha.0.tgz | d24a401104a220ab3951f6395edd4bd809a77a13661830be58391315dba77c40 | 53 |
| @the-open-engine/opcore-validation-typescript | the-open-engine-opcore-validation-typescript-0.1.0-alpha.0.tgz | 67fc29226b6509fd28290f6c86c75fdf6ba229c1599121baa3b5a01cb664a1af | 41 |
| @the-open-engine/opcore-asp-provider | the-open-engine-opcore-asp-provider-0.1.0-alpha.0.tgz | 8d5f39f48d6c74aded4ab7b9811526a3f9e24c1b06f941295ca98ceb5420fb4c | 27 |

## Reports

| Report | Status | SHA-256 | Summary |
|--------|--------|---------|---------|
| package-inspection | passed | n/a | npm pack package inspection passed |
| license | passed | 3515d1c895d2486baad3d81dcb0808ccbe236c25b7a5ef45061ded725048f607 | 11 production dependencies, 0 unresolved |
| provenance | passed | a4b840039db7593c7c0ebc474080801c2610127b50d20a81024d111a1feabf57 | 387 files, 60 commits scanned |
| release-hygiene | passed | a0e67a9211179dd385f995d9ba6fa8db787da285dc6dd89fef6c90d10cfa8765 | release hygiene check passed |
| graph-release | passed | 96bd45bb9b77afd8a290521e105e13ddac0367870f5a850f98414a14136ad3a2 | graph release receipt #17 validated as input evidence |
| secret-history | passed | 7060c267c912e3156b87c646e3bc970eac1ac8bdd964cf0a794b83e6f1250614 | 386 files, 61 commits scanned |

Secret allowlist: docs/release/secret-scan-allowlist.json. Add entries only for reviewed false positives with path or commit scope, reviewer, reason, expiry, and optional fingerprint/kind narrowing.

Publish status: this gate packs and verifies artifacts only. Publishing remains manual.

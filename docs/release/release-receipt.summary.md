# Release Receipt Summary

Maintainer release receipt for the Lattice alpha package gate.

Machine receipt: docs/release/release-receipt.json
Machine receipt SHA-256: c45da04b34794d940e4d1eefc8f4d1b18522318f4d750ba7df18267fe4929199

Canonical command groups: graph, inspect, edit, check, validate, status, doctor
Native graph artifacts: 3
Secret/history findings: 0
License unresolved count: 0

## Packages

| Package | Tarball | SHA-256 | Files |
|---------|---------|---------|-------|
| @the-open-engine/lattice-contracts | the-open-engine-lattice-contracts-0.1.0-alpha.0.tgz | 6801e8dda1ed82724bfa95d70ab7b7c4af4f87016a7471eb4cdfb425dda382b5 | 6 |
| @the-open-engine/opcore | the-open-engine-opcore-0.1.0-alpha.0.tgz | 8d2858dad630606d3bd6984d9a13a547a04a2f469750172e031bb63577ac3e32 | 32 |
| @the-open-engine/lattice-cli | the-open-engine-lattice-cli-0.1.0-alpha.0.tgz | b05924813e985235f383c994ceeb4633d0fb1058f7030e1a5492a7a003710998 | 30 |
| @the-open-engine/lattice-graph | the-open-engine-lattice-graph-0.1.0-alpha.0.tgz | b3c0d26e66d9ff66d62890c77411c540d98892cefa320291f783d106517de7d6 | 17 |
| @the-open-engine/opcore-graph-core-darwin-arm64 | the-open-engine-opcore-graph-core-darwin-arm64-0.1.0-alpha.0.tgz | ac6c9c61a0bcd799973d871a39d7d694a45875aefda34dfb83754df0dd4795ad | 5 |
| @the-open-engine/opcore-graph-core-darwin-x64 | the-open-engine-opcore-graph-core-darwin-x64-0.1.0-alpha.0.tgz | f589d3df77bbbdeb24f29d4b7c3dcc36d79397441be9e1b2bcc8c59110d637e3 | 5 |
| @the-open-engine/opcore-graph-core-linux-x64 | the-open-engine-opcore-graph-core-linux-x64-0.1.0-alpha.0.tgz | 02fb3bc51d95c5f3f6c7940c9695c7061f113542542a454db783cad2b8b72e41 | 5 |
| @the-open-engine/lattice-edit | the-open-engine-lattice-edit-0.1.0-alpha.0.tgz | 43048ec715740e326b9fb58e5bbc57eca75aa0d32ce1a49b08d1a5ea603e0104 | 71 |
| @the-open-engine/lattice-validation | the-open-engine-lattice-validation-0.1.0-alpha.0.tgz | 1c79b723abd731e75981c0f0811eb4904e521254cd4b945da5bc49f33ec975ad | 38 |
| @the-open-engine/lattice-validation-rust | the-open-engine-lattice-validation-rust-0.1.0-alpha.0.tgz | be71165c1846d1f9d35eb1b3557b7a16386ced45d47ac8a82341dac0ed599d14 | 53 |
| @the-open-engine/lattice-validation-typescript | the-open-engine-lattice-validation-typescript-0.1.0-alpha.0.tgz | f56d255773f271c7574aab364e6de6e5f305c6a27c285945eca01e9b2e14d2d7 | 41 |
| @the-open-engine/opcore-asp-provider | the-open-engine-opcore-asp-provider-0.1.0-alpha.0.tgz | 9367e33f76b7970fc40b9c1159e147467172e85fe10f2fd9575f9a3ee806d624 | 27 |

## Reports

| Report | Status | SHA-256 | Summary |
|--------|--------|---------|---------|
| package-inspection | passed | n/a | npm pack package inspection passed |
| license | passed | 1d3f69b3e24fe8f231b86070b6f0d69a6896a4431d0c23c8ee6dce0d9b58799b | 11 production dependencies, 0 unresolved |
| provenance | passed | 8195ffea373f98c4bc6d12d6397a2cbc9693b19cec003c4609f3d4a9d652834a | 379 files, 137 commits scanned |
| release-hygiene | passed | 1eacf13c0ffc89796ffd042ad94928c784e0513a06fd51b04ecea27db08b524a | release hygiene check passed |
| graph-release | passed | 3eb840352a74cee3ee9a44cb26b58dd05dacc016662bfa0973d20de5b280a183 | graph release receipt #17 validated as input evidence |
| secret-history | passed | 7060c267c912e3156b87c646e3bc970eac1ac8bdd964cf0a794b83e6f1250614 | 378 files, 137 commits scanned |

Secret allowlist: docs/release/secret-scan-allowlist.json. Add entries only for reviewed false positives with path or commit scope, reviewer, reason, expiry, and optional fingerprint/kind narrowing.

Publish status: this gate packs and verifies artifacts only. Publishing remains manual.

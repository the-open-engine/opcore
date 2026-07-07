# Release Receipt Summary

Maintainer release receipt for the Opcore alpha package gate.

Machine receipt: docs/release/release-receipt.json
Machine receipt SHA-256: 45638f8031168bfd32101a76cee88eb835406855da0142f0f6c9f20c479f296d

Canonical command groups: graph, inspect, edit, check, validate, status, doctor
Native graph artifacts: 3
Secret/history findings: 0
License unresolved count: 0

## Packages

| Package | Tarball | SHA-256 | Files |
|---------|---------|---------|-------|
| opcore | opcore-0.1.0.tgz | 18ef2b5d69b0004c835e4a55fcaae5bddfb1bba1190a85c95f387bb0d4afe00a | 1008 |

## Reports

| Report | Status | SHA-256 | Summary |
|--------|--------|---------|---------|
| package-inspection | passed | n/a | npm pack package inspection passed |
| license | passed | aaca97fbd7e61ac50129aa4c28768b7707001aada36e4bfa12518b86d45ca963 | 118 production dependencies, 0 unresolved |
| provenance | passed | c3117649e9c98b7d7f4506e1fbbb30b28f83dad82c313709735d402104f282d3 | 528 files, 239 commits scanned |
| release-hygiene | passed | 56dcec52a6f3f89e534306d6674d1ec8dad0d39b1fe35b0c977e0633f0cadd41 | release hygiene check passed |
| graph-release | passed | b440dc936876a4696152da6b915da6c7f8b1baa81e555a2d89020ef803ce3abb | graph release receipt #17 validated as input evidence |
| secret-history | passed | 7060c267c912e3156b87c646e3bc970eac1ac8bdd964cf0a794b83e6f1250614 | 525 files, 239 commits scanned |

Secret allowlist: docs/release/secret-scan-allowlist.json. Add entries only for reviewed false positives with path or commit scope, reviewer, reason, expiry, and optional fingerprint/kind narrowing.

Publish status: this gate packs and verifies artifacts only. Publishing remains manual.

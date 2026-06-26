# ASP Dogfood Receipt Summary

Issue #120 receipt for advisory standalone ASP manager dogfood.

Machine receipt: docs/release/asp-dogfood-receipt.json
Machine receipt SHA-256: 9695e46044a028de11491e1f5a6fab60919c06bea56877c6a23d0b6b4beea12d
Bootstrap source: local-sibling
Repo enrollment mode: advisory
Provider command: opcore-asp-provider --stdio
Host assurance: gated
Transaction guarantee: none
Old-tool replacement claimed: false

| Guardrail | Status | Exit | Evidence |
|-----------|--------|------|----------|
| current-tools-validate-changed | passed | 0 | current-tools:validate-changed remains active |
| current-tools-validate-rust-graph | passed | 0 | current-tools:validate-rust-graph remains active |
| current-tools-validate-all | retained-not-run | not-run | Retained old-tool guardrail; omitted unless --include-current-tools-all is passed |

## Deferred Coverage

- inspect: parity-blocker; ASP dogfood covers Core check/evaluate only; inspect request/response mapping remains outside #120.
- edit: retained-old-tool-gate; ASP dogfood does not authorize edits or apply behavior; edit parity remains covered by current old-tool and cutover gates.

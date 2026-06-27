# Cutover Receipt Summary

Maintainer cutover gate proves installed Lattice artifacts handle canonical release commands without dev-tool fallback.

Machine receipt: docs/release/cutover-receipt.json
Machine receipt SHA-256: 9e5df155f14a2acd64fa3cc30f7d880c97998a5a373ae9549528569ab764c213

Installed packages: 10
Command receipts: 28
Rust command receipts: 7
Forbidden marker findings: 0
Input evidence: #17, #29, #58

| Command | Owner | Status | Exit | Assertion |
|---------|-------|--------|------|-----------|
| opcore-scan | runtime | ok | 0 | opcore scan wrote read-only report artifacts |
| opcore-status | runtime | ok | 0 | opcore status returned repoState |
| opcore-check-changed | validation | ok | 0 | opcore check changed defaulted base to HEAD |
| opcore-measure | runtime | ok | 0 | opcore measure returned read-only report deltas |
| opcore-try | runtime | ok | 0 | opcore try generated local sample repos without publishing |
| status | runtime | ok | 0 | runtime status reports validation readiness |
| doctor | runtime | ok | 0 | runtime doctor reports validation readiness |
| graph-build | graph | ok | 0 | graph build completed with native artifact |
| graph-status | graph | ok | 0 | graph status available after build |
| graph-query | graph | ok | 0 | graph query returned facts |
| graph-impact | graph | ok | 0 | graph impact returned file impact |
| graph-review-context | graph | ok | 0 | graph review-context returned related facts |
| graph-detect-changes | graph | ok | 0 | graph detect-changes returned typed change data |
| graph-search | graph | ok | 0 | graph search returned ranked results |
| graph-serve | graph | ok | 0 | graph serve status route is ready |
| inspect-symbols | inspect | ok | 0 | inspect symbols returned graph symbols |
| inspect-definition | inspect | ok | 0 | inspect definition returned a symbol |
| inspect-references | inspect | ok | 0 | inspect references returned callers |
| inspect-signature | inspect | ok | 0 | inspect signature returned read-only language-service signatures |
| inspect-implementations | inspect | ok | 0 | inspect implementations returned implementation evidence |
| inspect-search | inspect | ok | 0 | inspect search returned graph search results |
| edit-preview | edit | ok | 0 | safe edit preview produced a plan without writing |
| edit-apply | edit | ok | 0 | safe edit apply wrote after validation |
| edit-refused | edit | error | 1 | validation-refused edit left file unchanged |
| check-files | validation | ok | 0 | check files passed syntax and type checks |
| validate-request | validation | ok | 0 | validate request passed |
| validate-pre-write-pass | validation | ok | 0 | pre-write pass receipt was ok |
| validate-pre-write-fail | validation | error | 1 | pre-write failure receipt failed closed |

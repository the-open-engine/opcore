---
title: Core, assurance, and hostile conformance requirements
status: draft
normative: true
summary: Stable requirement IDs for private ASP v1.0 Core Profile host, check-provider server, interop, edit/apply host, assurance honesty, and hostile-provider matrix reports.
updated: 2026-06-26
---

# Core, Interop, Edit, Assurance, And Hostile Conformance Requirements

These requirement IDs define the private ASP v1.0 Core Profile report scopes. `CORE-*` covers the
current host/Core smoke report. `CORE-SERVER-*` covers the black-box Core check-provider server
suite. `INTEROP-*` covers private host/server interoperability evidence through the same ordinary
Core provider contract. `HOSTILE-*` covers the private black-box hostile-provider matrix beyond Core.
`EDIT-HOST-*` covers the private black-box host-mediated edit/apply profile. `ASSURANCE-*` covers
honest assurance-mode and transaction-guarantee reporting for apply paths. No scope creates trust,
authority, certification, registry, provider-approval, stable API, public-release, isolated-assurance,
mediated-write, staged-snapshot, or workspace-transaction claims.

| ID | Requirement |
|---|---|
| CORE-HOST-STATUS | Black-box `asp host serve` `host/status` reports ready or explicitly degraded Core state, policy identity, required check coverage, provider state, and receipt coverage. |
| CORE-HOST-CAPABILITIES | Black-box `asp host serve` `host/capabilities` reports check as the required Core capability, keeps inspect and edit non-Core, and exposes required/enrolled/ran/degraded coverage. |
| CORE-HOST-EVALUATE | Black-box `asp host serve` `host/evaluateChangeset` returns host-owned allow, deny, and indeterminate Decision envelopes for Core gate cases. |
| CORE-CHECK-ASSESSMENT | `check/evaluate` provider outputs use the canonical Assessment contract: status, diagnostics/evidence, coverage, `validAsOf`, provider metadata, timing, and cache metadata. |
| CORE-CHECK-CONFIGURATION | Providers validate optional request configuration, apply one effective configuration to both views, and report its stable configDigest for every assessment status. Hosts reject a mismatched digest. |
| CORE-PROVIDER-FORBIDDEN-FIELDS | Provider Assessment payloads exclude host-owned decision, verdict, pass, disposition, authority, assurance, transaction, apply, and apply-receipt fields, including nested provider data. |
| CORE-STALE-VALID-AS-OF | A black-box required provider Assessment with stale `validAsOf` cannot contribute to `allow` and remains visible as degraded coverage. |
| CORE-MISSING-REQUIRED-PROVIDER | A black-box missing required Core check provider cannot produce `allow` and remains visible as degraded coverage. |
| CORE-MISSING-AUTHORITY | Black-box initialized, fresh, complete provider coverage without explicit gate authority cannot produce `allow` and remains visible as degraded coverage. |
| CORE-INSUFFICIENT-ASSURANCE | Black-box initialized, authorized, fresh provider coverage below required gate assurance cannot produce `allow` and reports achieved assurance. |
| CORE-PROVIDER-QUARANTINED | Black-box quarantined required Core check provider health cannot produce `allow` and remains visible as degraded coverage. |
| CORE-PROVIDER-SKEWED | Black-box skewed or incompatible required Core check provider enrollment cannot produce `allow` and remains visible as degraded coverage. |
| CORE-HOST-INITIALIZE-CONTRACT-REFUSAL | Black-box required Core check provider initialize/version contract refusal cannot produce `allow`, reports `skewed` degraded coverage, and carries no initialized provider provenance. |
| CORE-PROVIDER-FAIL-OPEN | Black-box fail-open required Core check provider health cannot produce `allow` and remains visible as degraded coverage. |
| CORE-MALFORMED-REQUIRED-PROVIDER | Black-box malformed, nested host-owned, or forged provider data cannot produce `allow` and remains visible as degraded coverage. |
| CORE-REQUIRED-COVERAGE-VISIBLE | Black-box missing, unavailable, incompatible, malformed, stale, incomplete, unsupported, cancelled, timed-out, crashed, quarantined, missing-authority, insufficient-assurance, direct-write-risk, and policy-self-authorization coverage stays machine-readable in `coverage.required`, `coverage.ran`, and `coverage.degraded`. |
| CORE-HOST-DECISION-AUTHORITATIVE | Providers produce Assessments; black-box host behavior shows only the host produces the final `allow`, `deny`, or `indeterminate` gate Decision and receipt. |
| CORE-NO-LATTICE-FAST-PATH | A direct or privileged Lattice gate, freshness, authority, or apply path is rejected as degraded behavior rather than accepted as Core evidence. |
| CORE-SERVER-INITIALIZE | A Core check provider `initialize` result reports server identity, fingerprint, provenance, check capability, and read-only permission request. |
| CORE-SERVER-UNSUPPORTED-PROTOCOL | A Core check provider rejects unsupported `initialize.protocolVersion` with typed contract failure before `initialized`, host callbacks, or satisfiable Core coverage. |
| CORE-SERVER-PREINITIALIZED | `check/evaluate` before `initialized` fails with a typed provider-not-initialized JSON-RPC error and cannot satisfy Core coverage. |
| CORE-SERVER-INITIALIZED-GRANT | The provider records the narrowed read-only `initialized` grant and receives no write or network authority. |
| CORE-SERVER-CALLBACK-CONTENT | The provider obtains baseline and changeset content through `workspace/listTree` and `workspace/readBlob` callbacks. |
| CORE-SERVER-GRANT-SCOPE | Fake-host callbacks filter tree entries and blob bytes to the initialized read grant and reject out-of-grant blob reads. |
| CORE-SERVER-VALID-RESULTS | Complete clean, complete diagnostic, incomplete, unsupported, and cancelled results validate as provider Assessments. |
| CORE-SERVER-TYPED-ERROR | Provider inability to evaluate is reported on the JSON-RPC error channel with typed `failClass` data. |
| CORE-SERVER-REJECTED-MALFORMED-HOST-FIELDS | Malformed provider outputs and top-level or nested host-owned fields are rejected as non-passing server evidence. |
| CORE-SERVER-REJECTED-FRESHNESS | Stale `validAsOf.baseline`, changeset digest, or blob freshness is rejected as non-passing server evidence. |
| CORE-SERVER-TIMEOUT | A hung provider is reported as failed or missing required server evidence, never as pass. |
| CORE-SERVER-BEHAVIOR-ONLY | Provider outputs remain Assessments only and are never accepted as host Decisions, authority grants, assurance, receipts, or verdicts. |
| INTEROP-REF-HOST-FAKE | The Open Engine reference host interoperates with the fake Core check provider over JSON-RPC stdio using the ordinary provider contract. |
| INTEROP-REF-HOST-OPCORE | The Open Engine reference host interoperates with Opcore as an ordinary enrolled ASP provider through manager-owned manifest state. |
| INTEROP-INDEPENDENT-HOST-FAKE | A minimal independent host harness interoperates with the fake Core check provider through initialize, initialized grant, host callbacks, and check Assessment validation. |
| INTEROP-INDEPENDENT-HOST-OPCORE | A minimal independent host harness interoperates with the Opcore provider entrypoint through the same provider contract. |
| INTEROP-UNSUPPORTED-COVERAGE-VISIBLE | Unsupported or missing capability coverage remains explicit Assessment/report detail and cannot silently count as passing support. |
| INTEROP-NO-OPCORE-FAST-PATH | Interop tests, fixtures, and runners contain no privileged Opcore, old-tool, or temporary guardrail fast-path calls. |
| INTEROP-PRIVATE-CLAIMS | Interop reports remain private behavior evidence and make no trust, authority, certification, registry, provider-approval, stable API, or public-release claim. |
| HOSTILE-MALFORMED-INITIALIZE | Black-box host evaluation rejects malformed provider initialize results and records degraded required coverage instead of allowing silently. |
| HOSTILE-MALFORMED-ASSESSMENT | Black-box host evaluation rejects malformed provider Assessment payloads and records degraded required coverage instead of allowing silently. |
| HOSTILE-FORGED-HOST-FIELDS | Provider-minted host-owned decision, verdict, pass, authority, assurance, transaction, apply, or receipt fields are rejected or degraded. |
| HOSTILE-STALE-ASSESSMENT | Stale required provider `validAsOf` data cannot produce `allow` and remains visible as degraded coverage. |
| HOSTILE-MISSING-REQUIRED-PROVIDER | A missing required provider cannot produce `allow` and keeps required, ran, degraded, receipt failure, and provenance gaps visible. |
| HOSTILE-OPTIONAL-DEGRADED-PROVIDER | Optional provider failure remains visible in decision, status, and capability coverage while clean required coverage may still allow the gate. |
| HOSTILE-UNSUPPORTED-REQUIRED-CAPABILITY | A required provider that does not advertise its enrolled required capability is incompatible health with unsupported degraded coverage. |
| HOSTILE-INCOMPLETE-REQUIRED-COVERAGE | Incomplete required provider coverage cannot produce `allow` and remains machine-readable in degraded coverage and receipt failures. |
| HOSTILE-PROVIDER-ERROR | Provider error during required evaluation cannot produce `allow` and remains machine-readable in degraded coverage and receipt failures. |
| HOSTILE-CANCELLED-PROVIDER-REQUEST | Cancelled provider evaluation cannot produce `allow` and remains machine-readable in degraded coverage and receipt failures. |
| HOSTILE-SLOW-PROVIDER-TIMEOUT | Slow required provider timeout cannot produce `allow` and remains machine-readable in degraded coverage and receipt failures. |
| HOSTILE-PROVIDER-CRASH | Provider crash during initialize or active request cannot produce `allow` and remains machine-readable in degraded coverage and receipt failures. |
| HOSTILE-QUARANTINED-PROVIDER | Quarantined required provider health cannot produce `allow` and remains visible as degraded coverage. |
| HOSTILE-MISSING-AUTHORITY | Fresh complete provider coverage without explicit required authority cannot produce `allow` and records host-owned authority evidence. |
| HOSTILE-INSUFFICIENT-ASSURANCE | Authorized provider coverage below required gate assurance cannot produce `allow` and reports achieved assurance honestly. |
| HOSTILE-POLICY-SELF-AUTHORIZATION | Candidate policy/config changes cannot authorize, select, or weaken the gate evaluating the same changeset. |
| HOSTILE-DIRECT-WRITE-RISK | Declared direct-write risk or untrusted edit launch cannot be treated as mediated host authority or a passing gate. |
| HOSTILE-COMMAND-LIKE-EDIT-OUTPUT | Command-like edit output is rejected before apply and leaves the workspace unchanged. |
| HOSTILE-NO-OPCORE-FAST-PATH | Hostile tests, fixtures, and runners contain no privileged reference-provider, old-tool, or temporary guardrail fast-path calls. |
| EDIT-HOST-REQUEST-PLAN-NO-WRITE | `host/requestEditPlan` returns provider EditPlan data and a host receipt without mutating the workspace or accepting provider-owned decisions, commands, or apply receipts. |
| EDIT-HOST-POSITIVE-APPLY | `host/applyProposal` validates and applies a canonical provider EditPlan through the host, reports actual assurance mode and transaction guarantee, and writes the expected content. |
| EDIT-HOST-STALE-PLAN | Stale provider EditPlan baseline or `validAsOf` data is rejected before apply and leaves the workspace unchanged. |
| EDIT-HOST-CAS-CONFLICT | Apply validates expected before digests and refuses a changed file without overwriting current content. |
| EDIT-HOST-PATH-POLICY | Apply validates touched-resource preconditions, expected absence for creates, and requested path scope before writing. |
| EDIT-HOST-UNKNOWN-PROPOSAL | Apply refuses unknown or uncached proposal identity before validation or mutation. |
| EDIT-HOST-DENIED-VALIDATION | Host deny validation over the hypothetical after-state prevents apply and reports blocking diagnostic coverage. |
| EDIT-HOST-INDETERMINATE-VALIDATION | Indeterminate host validation over the hypothetical after-state prevents apply and reports incomplete coverage. |
| EDIT-HOST-COMMAND-LIKE-OUTPUT | Command-like provider edit output is rejected as provider data, not executed or converted into host apply behavior. |
| EDIT-HOST-DIRECT-WRITE-RISK | Direct-write provider output and untrusted writable edit launch are rejected before apply. |
| EDIT-HOST-MALFORMED-OUTPUT | Malformed provider edit output is rejected before apply and cannot satisfy edit coverage. |
| EDIT-HOST-HOST-FIELD-SMUGGLING | Provider-owned decisions, apply receipts, authority, assurance, transaction, or receipt fields in edit output are rejected. |
| EDIT-HOST-MISSING-AUTHORITY | Missing explicit edit authority prevents required apply paths and reports host-owned authority evidence. |
| EDIT-HOST-INSUFFICIENT-ASSURANCE | Advisory edit isolation cannot satisfy required apply assurance and reports achieved assurance honestly. |
| EDIT-HOST-CONCURRENT-APPLY | Concurrent apply attempts are serialized or refused so only one write can succeed. |
| EDIT-HOST-NO-OPCORE-FAST-PATH | Edit/apply tests, fixtures, and runners contain no privileged reference-provider, old-tool, or temporary guardrail fast-path calls. |
| ASSURANCE-ADVISORY-REPORTING | Advisory edit authority reports advisory/none, refuses apply requiring stronger assurance, and leaves the workspace unchanged. |
| ASSURANCE-GATED-BOUNDARY | Gated edit apply reports gated/none and identifies the gate validation and interactive apply boundary being controlled. |
| ASSURANCE-MEDIATED-WRITE-DOWNGRADE | Requested mediated-write evidence without enforced host-mediated writes is refused or downgraded to weaker assurance. |
| ASSURANCE-ISOLATED-DOWNGRADE | Requested isolated evidence without enforced provider write isolation is refused or downgraded to weaker assurance. |
| ASSURANCE-DIRECT-WRITE-REFUSAL | Direct-write provider output and untrusted editable launch cannot pass as mediated-write, isolated, or successful apply evidence. |
| ASSURANCE-TRANSACTION-GUARANTEE-BOUND | Every observed transaction guarantee is schema-accepted and no stronger than the current none guarantee. |
| ASSURANCE-FAILED-APPLY-NO-SUCCESSFUL-RECEIPT | Provider crash, command-like edit output, denied validation, and indeterminate validation cannot produce misleading successful apply receipts. |

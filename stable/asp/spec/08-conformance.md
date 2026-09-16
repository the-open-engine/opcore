---
title: Conformance
status: draft
normative: true
summary: Behavior-evidence conformance levels per canonical capability family, semantic-pack assertions, host negative cases, authority evidence, receipts, and version negotiation.
updated: 2026-06-23
---

# Conformance

> **2026-06-22 correction:** Conformance proves protocol behavior; it does not grant trust or gate
> authority. Conformance targets capability families (`inspect`, `check`, `edit`) plus host
> behavior. Authority posture is governed by
> [ADR 0023](../decisions/0023-assurance-modes-and-authority-axes.md) and
> [the governance draft](../docs/governance/governance-draft.md).

Conformance is black-box protocol behavior evidence for hosts, servers, and capability families. It
has three parts: a per-capability checklist, a black-box assertion suite, and an assertion manifest.
It does not establish identity, integrity, isolation, trusted policy, certification, registry
inclusion, or blocking authority. The conformance model is normative and specified here; the suite
harness is an implementation deliverable.

ASP has two conformance targets:

- **Host conformance** tests the harness-to-host outer seam, host-to-provider supervision, freshness,
  policy, aggregation, decisions, mediated apply, assurance reporting, receipts, and degraded
  coverage.
- **Server conformance** tests provider behavior for the `inspect`, `check`, and `edit` capability
  families. The older `sense`, `judge`, and `act` chapters remain legacy role text for those
  capabilities.

A candidate passes only the target it actually implements. A provider that passes every server test
still cannot satisfy a gate until trusted policy grants authority. A host that passes every host test
still does not become the mandatory ASP runtime.

The [Core Profile](./11-core-profile.md) is the tiny first conformance and adoption target:
`host/status`, `host/capabilities`, `host/evaluateChangeset`, `initialize`/`initialized`,
`workspace/readBlob`, `workspace/listTree`, and `check/evaluate`. Inspect, edit, apply, deployment
surfaces, dogfood, ACE integration, and reference-engine parity are optional non-Core profiles and
cannot replace Core host/provider/check receipts.

The private Core report scaffolds in [`docs/conformance/`](../docs/conformance/) assign stable
`CORE-*` requirement IDs for the current host/Core smoke assertions and stable `CORE-SERVER-*`
requirement IDs for the black-box Core check-provider server assertions. The host report emits the
behavior-only shape described by
[`schemas/conformance-report.schema.json`](../schemas/conformance-report.schema.json); the server
report stays separate so check-provider evidence does not become a host Decision or authority
artifact. Core reports are narrow traceability artifacts for the current Core suites. They cannot
represent full #8 host/server conformance, edit/apply conformance, mediated-write or isolated
assurance proof, independent-host evidence, second-server evidence, public-release evidence, ACE
dogfood, or Lattice parity.

## Server Conformance

A server claims one or more capability families. It is conformant for a family only when it satisfies
that family's MUSTs plus the shared spine.

**Spine for all servers:**

- Completes `initialize` and reports a fingerprint that changes on rebuild.
- Treats `grantedPermissions` as authoritative and obtains content only through host callbacks such
  as `workspace/readBlob` and `workspace/listTree`.
- Carries `validAsOf` on every response and binds it to the host-issued baseline.
- Surfaces inability to evaluate on the error channel with a typed `failClass`; surfaces assessments
  or edit plans on the result channel.
- Never returns an authoritative gate decision or verdict object.
- Respects `shutdown`/`exit`, cancellation, callback budgets, response-size budgets, and sandbox
  limits.

**Inspect capability MUSTs:**

- Declare canonical `inspect` support and any retained legacy `sense` metadata as compatibility-only.
- Answer relative to the effective baseline and carry `validAsOf` on every result.
- Return the normalized graph envelope for typed inspect verbs.
- Obtain content only via `workspace/readBlob`/`listTree`; do not assume filesystem access.
- Remain side-effect free; inspect diagnostics are advisory and never gating.

**Check capability MUSTs:**

- Declare canonical `check` support, capability version, diagnostic sources, scopes, supported
  comparisons, partial-result support, incremental support, and unsupported-reporting semantics.
- Return provider assessments with explicit `status`, diagnostics/evidence, requested/covered/
  degraded/unsupported `coverage`, `validAsOf`, provider metadata, timing, and cache metadata.
- Use only `complete | incomplete | unsupported | error | cancelled` status values and keep
  unsupported capability/scope/language gaps distinct from provider/runtime errors.
- Treat `before`/`after` as blob refs and obtain bytes only via `workspace/readBlob`.
- Emit stable, position-resilient `fingerprint`s and return `introduced` diffs when advertised.
- Reserve the JSON-RPC error channel for inability to evaluate, with typed `failClass`.
- Never include host-owned pass/fail projections, decisions, verdict envelopes, finding dispositions,
  authority grants, assurance modes, or transaction guarantees in provider results.
- Treat SARIF as export/mapping only; native ASP check conformance uses Assessment objects.
- Never write to the workspace or act outside granted read permissions.

**Edit capability MUSTs:**

- Declare canonical `edit` support, capability version, operation support, text-edit support,
  whole-resource support, rename/move support, required precondition support, blob-upload support,
  and status-based partial proposal semantics.
- Return edit plans/proposals only; never write to the workspace directly.
- Compute proposals against the request baseline and carry exact `validAsOf`.
- Include touched resources, structured operations, preconditions, and digest-bound text edit ranges.
- Set explicit `incomplete`, `unsupported`, `error`, or `cancelled` status data when the operation
  cannot be fully represented.
- Produce edits that apply cleanly to their stated baseline or report incompleteness/refusal/conflict.
- Never return shell commands, arbitrary scripts, command arrays, patch shellouts, host decisions,
  verdict envelopes, authority grants, achieved assurance modes, or transaction guarantees.
- Never request autonomous apply; the conforming write-attempt surface is host-owned
  `host/applyProposal`.

## Host Conformance

A conforming host coordinates one operation. It may be embedded in an editor, harness, CI system,
vendor runtime, or the Open Engine reference/default host implementation. The host suite MUST run
against fake minimal providers and at least one independent provider fixture; Open Engine and Lattice
implementations are tested only through the same contracts.

## v1.0 semantic-pack assertions

| Semantic object | Assertion |
|---|---|
| `SnapshotRef` / `Baseline` | The host is the sole issuer; every provider result binds freshness with `validAsOf`. |
| `ChangeSet` | Candidate input is content-addressed blob transitions over the snapshot, not inline authoritative bytes. |
| `Assessment` | Check providers return status, diagnostics/evidence, coverage, freshness, provider, timing, and cache metadata; never host-owned decision, authority, assurance, or transaction fields. |
| `EditPlan` | Edit providers return structured operations and preconditions; they do not write or grant apply authority. |
| `Decision` | Only the host returns `allow`, `deny`, or `indeterminate`; `verdict` is a transitional host envelope. |
| Coverage | Host decision coverage includes `required`, `ran`, and `degraded`; transitional `enrolled` equals `required`. |
| Assurance | Host decisions and apply receipts report achieved assurance mode and never overclaim isolation or direct-write prevention. |
| Transaction guarantee | Apply receipts report the guarantee actually achieved and never claim stronger atomicity than the deployment enforces. |
| Base-policy authority | Policy/config changes are evaluated under trusted base policy or a non-weakenable organization floor. |

Host assertions include:

- **Topology:** the harness calls the host; the host calls enrolled providers; providers never compose
  directly for freshness, policy, authority, gate decisions, or apply.
- **Capability aggregation:** `host/capabilities` and `host/status` expose the composed capability
  surface after policy, health, version, and authority checks.
- **Decision ownership:** `host/evaluateChangeset` returns a host-produced envelope with `decision`,
  `pass`, `callSite`, `coverage.required`, `coverage.ran`, `coverage.degraded`, `validAsOf`,
  authority evidence, assurance mode, policy digest, receipt data, and transaction guarantee when
  relevant.
- **Freshness:** the host rejects, downgrades, or re-issues assessments whose `validAsOf` baseline,
  changeset digest, or blob set differs from the host-issued request; stale assessments cannot
  contribute to `allow`.
- **Authority:** identity, integrity, conformance, isolation, and explicit authority grant are
  recorded separately. Certification or first-party provenance alone never grants blocking authority.
- **Mediated apply:** `host/requestEditPlan` writes nothing; `host/applyProposal` requires explicit
  apply intent, validates the hypothetical changeset, reports the achieved transaction guarantee, and
  forbids autonomous server-triggered writes.
- **Assurance honesty:** the host never claims `mediated-write` or `isolated` without an enforceable
  write boundary, and never claims a stronger transaction guarantee than it can enforce.
- **Auditability:** degraded coverage, fail-open events, quarantine, policy activation, provider
  authority, policy digest, freshness evidence, and apply receipts are visible to the harness.

## Required Negative Assertions

The suite MUST turn the seed fixtures in [`examples/outer/`](../examples/outer/) into host assertions:

- **Missing provider:** a `gate` evaluation with an absent, unavailable, quarantined, or incompatible
  required provider reports degraded coverage and returns `indeterminate` or `deny`, never silent
  allow.
- **Stale assessment:** a provider response with a mismatched `validAsOf` is rejected, downgraded, or
  re-issued. If it cannot be refreshed, degraded coverage uses `stale` and the gate is not allowed.
- **Missing authority:** identity, integrity, or conformance evidence without an active named
  authority grant cannot satisfy a gate.
- **Insufficient assurance:** a provider that cannot achieve the required assurance mode reports
  degraded coverage and cannot produce `allow` for a gate.
- **Malformed provider:** incomplete, malformed, unsupported, cancelled, timed-out, or errored
  required assessments cannot silently pass a gate. A check result carrying host-owned pass/fail,
  decision, verdict, disposition, authority, assurance, or transaction fields is malformed.
- **Unsupported distinct from error:** unsupported language/scope/comparison/source/capability
  coverage remains distinguishable from provider/runtime errors in degraded coverage and metrics.
- **Coverage degradation matrix:** the seed fixture
  [`examples/outer/evaluate.indeterminate.coverage-degradation-matrix.json`](../examples/outer/evaluate.indeterminate.coverage-degradation-matrix.json)
  covers unsupported, incomplete, cancelled, quarantined, skewed, timed-out, and fail-open required
  coverage. Each degraded entry is visible and the gate remains non-passing.
- **Direct-write overclaim:** when server code can write the real worktree, the host reports
  `direct-write-risk`, avoids `mediated-write`/`isolated`, and avoids transaction guarantees stronger
  than the deployment can enforce.
- **Candidate policy self-authorization:** a changeset that modifies `.asp/asp.json` to authorize its
  own provider or weaken gates is evaluated under trusted base policy or a non-weakenable
  organization floor. Candidate policy may be pending; it cannot authorize itself.
- **Lattice fast path:** Lattice is exercised as an enrolled provider/server/reference engine only.
  Any direct Lattice gate, authority, freshness, or apply path that bypasses host/provider contracts
  is rejected the same way a fake or third-party provider bypass is rejected.
- **Stale proposal:** an otherwise valid `EditPlan` whose baseline, `validAsOf`, touched-resource
  digest, or text edit range basis does not match the current candidate is rejected, re-issued, or
  downgraded. It MUST NOT silently apply or become `allow`.
- **Edit conflict:** touched-path drift, overlapping proposals, failed preconditions, missing blobs,
  malformed edits, unsupported operations, and unresolved 3-way merges produce explicit refusal or
  degraded data. The host MUST NOT force-overwrite local changes.
- **Denied edit validation:** if required checks over a hypothetical after-state return host
  `deny`, `host/applyProposal` returns `applied:false` and no new baseline.
- **Indeterminate edit validation:** if required coverage is missing, stale, incomplete, unsupported,
  malformed, cancelled, errored, or insufficiently authorized, `host/applyProposal` returns
  `applied:false` unless policy explicitly allows a reduced non-gate requirement.
- **Command-like edit output:** provider output using shell commands, arbitrary scripts, command
  arrays, or patch shellouts as the authoritative mutation contract is malformed.
- **Host-owned fields in edit output:** provider `EditPlan` data containing host decisions, verdict
  envelopes, authority grants, gating dispositions, achieved assurance modes, or transaction
  guarantees is malformed or ignored as non-authoritative.

## Assertion Suite

A black-box driver plays the opposite side of the seam and checks behavior without reading
implementation source.

Server assertion families:

- **Handshake:** rejects unsupported `protocolVersion`; honors narrowed permissions; fingerprint
  changes across rebuild.
- **Least privilege:** out-of-grant blob reads are refused and do not cause escalation.
- **Freshness:** every response's `validAsOf` matches the host-issued baseline and blobs read.
- **Check:** `introduced` returns exactly `after \ before`; fingerprints are position-resilient; a
  negative assessment is a result; unsupported and error statuses are distinct; stale `validAsOf`
  equality covers baseline, changeset digest, and blob set; inability-to-run is an error carrying
  `failClass`.
- **Edit:** proposed edits write nothing, use structured operations and preconditions, apply cleanly
  to the stated baseline, and detect stale baselines, missing blobs, unsupported operations, or
  unresolved conflicts as explicit proposal status or host refusal data.
- **Inspect:** typed verbs return the normalized graph envelope; impact is conservative.

Host assertion families:

- **Outer seam:** every method family in
  [`schemas/outer-host.schema.json`](../schemas/outer-host.schema.json) is host-owned.
- **Decision envelope:** every evaluation validates against
  [`schemas/verdict.schema.json`](../schemas/verdict.schema.json).
- **Coverage:** every required source appears in `coverage.required[]` and then in `coverage.ran[]` or
  `coverage.degraded[]`; while `coverage.enrolled[]` remains transitional, it equals
  `coverage.required[]`.
- **Authority status:** `host/authority/status` exposes provider identity, integrity, conformance,
  isolation, and authority without conflating them.
- **No privileged implementation path:** fake hosts/providers and Lattice-backed configurations all
  face the same assertions.

## Conformance Evidence Manifest

A suite run emits a machine-readable evidence manifest for auditability, not authority:

```jsonc
{
  "target": { "kind": "server", "name": "acme-secrets", "version": "1.2.0", "fingerprint": "sha256:dd34" },
  "protocolVersion": "asp/1.0",
  "capabilityFamilies": ["check"],
  "roles": ["judge"],
  "assertions": [
    { "id": "spine/valid-as-of", "result": "pass" },
    { "id": "check/introduced-set-difference", "result": "pass" },
    { "id": "check/position-resilient-fingerprint", "result": "pass" },
    { "id": "check/error-carries-failclass", "result": "pass" }
  ],
  "summary": { "total": 4, "passed": 4, "failed": 0 },
  "conformance": "conformant"
}
```

The manifest is evidence of suite results only. It is not a certificate, registry entry, trust root,
or authority grant. Signing, provenance, certification-label, and registry mechanics are deferred to
private governance and public-release work.

For the Core Profile, the private report schema records `target`, `profile`, `suite`, `summary`,
`requirements`, `assertions`, `coverage`, `artifacts`, and `claims`. Core assertion results are
derived from the smoke suite result stream, not prefilled from the requirement catalog. A report that
is missing any required Core assertion, skips or marks required coverage TODO, or records degraded
required coverage MUST NOT summarize as `pass`. Its claims metadata keeps behavior-evidence and
private-only flags separate from trust, authority, certification, registry inclusion, public-standard,
provider-approval, and stable-public-API claims, which remain false.

## Conformance And Authority

Conformance is one evidence axis. It is separate from:

- identity/provenance;
- artifact integrity;
- isolation;
- explicit gate authority.

A provider blocks a commit only when trusted policy grants a pinned provider authority for a named
requirement and call-site. Passing a suite, emitting a manifest, carrying a certification label, or
appearing in a registry MUST NOT grant trust, registry inclusion, certification, blocking authority,
or gate authority by itself.

## Version Negotiation

ASP versions are negotiated per provider at `initialize`. Because third-party providers cannot be
rebuilt on demand, the rule is **negotiate or refuse**: the host either speaks a version the provider
supports, or declines it as a `contract` failure and reports degraded coverage when required. Silent
partial compatibility is non-conforming.

## Implementation Deliverables

- The suite harness and its concrete fixture-driven assertions.
- The fixture format so third parties can self-test before submitting conformance evidence.
- Signing, provenance, registry, and certification-label mechanics, if later approved by governance.

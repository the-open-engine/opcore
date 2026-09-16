---
title: ASP v1.0 Core Profile
status: established
normative: true
summary: Minimum Core Profile for evidence-backed code-change decisions.
updated: 2026-09-08
---

# ASP v1.0 Core Profile

The ASP v1.0 Core Profile is the smallest profile that can prove the host/provider/check
path:

```text
candidate changeset -> provider Assessment -> host Decision
```

Core is a profile over the existing semantic contract. It does not reopen the architecture, add a
new wire binding, replace current guardrails, or create a public standard, registry, release,
package, certification, or stable manifest claim.

## Scope

Core covers only blocking or advisory candidate evaluation through a conforming host. A Core harness
talks to the host, the host initializes and narrows check providers, providers read candidate content
only through host callbacks, providers return Assessments, and the host returns Decisions.

Core does not include inspect, edit planning, apply, manager daemon behavior, server catalogs, setup
wizards, agent-root hooks/skills, deployment manifests, dogfood migration, ACE integration, or parity
with any reference engine. Those are optional profiles or downstream work.

## Method And Object Set

Core host surface:

- `host/status`;
- `host/capabilities`;
- `host/evaluateChangeset`.

Core provider lifecycle:

- `initialize`;
- the host-sent `initialized` notification with narrowed `grantedPermissions`;
- host-visible lifecycle and per-capability health for enrolled providers.

Core workspace callbacks:

- `workspace/readBlob`;
- `workspace/listTree`.

Core check provider surface:

- `check/evaluate`.

Core semantic objects:

- host-issued `SnapshotRef` / `Baseline`;
- immutable content-addressed `ChangeSet`;
- provider-produced `Assessment`;
- host-produced `Decision`;
- decision `coverage.required`, `coverage.ran`, and `coverage.degraded`.

`Baseline` and the `baseline` field remain the v1.0 schema alias for the canonical `SnapshotRef`
object. `coverage.enrolled` remains a transitional alias and MUST equal `coverage.required` wherever
it appears.

## Candidate Flow

1. The host issues or confirms a `SnapshotRef` / `Baseline` for the candidate workspace state.
2. The harness submits a content-addressed `ChangeSet` to `host/evaluateChangeset`. Inline bytes are
   not authoritative candidate input.
3. The host selects required check providers from trusted policy and composed capabilities.
4. Each required provider is launched only from trusted installed/environment configuration, has
   completed `initialize`, and has received an `initialized` grant before it can satisfy Core
   coverage. Mutable repository policy cannot provide provider startup commands.
5. Providers read blobs and tree entries only through `workspace/readBlob` and `workspace/listTree`,
   scoped by the host grant.
6. Providers return `check/evaluate` Assessments with status, diagnostics/evidence, coverage,
   `validAsOf`, provider metadata, timing, and cache metadata.
7. The host rejects stale or malformed provider data, aggregates coverage and findings, applies
   policy and authority grants, and returns the host Decision envelope.

Direct provider calls, ordinary tool calls, or implementation-specific fast paths cannot satisfy a
Core gate. A gate output is the host Decision envelope, never a provider pass/fail projection.

## Decision Rules

For `host/evaluateChangeset`, only the host returns `allow`, `deny`, or `indeterminate`.

The host MAY return `allow` for a `gate` call-site only when all required coverage is fresh,
complete, authorized, compatible, and sufficient for the call-site, every required entry appears in
`coverage.ran`, `coverage.degraded` is empty for required coverage, the achieved assurance mode meets
policy, and no authorized gating finding remains.

The host MUST return `deny` when fresh, complete, authorized required coverage finds a blocking
policy violation or an authorized gating diagnostic that host arbitration does not clear. Core hosts
surface this non-allow path in `coverage.degraded` with reason `blocking-diagnostic` so deny receipts
remain machine-readable while providers still only contribute Assessment diagnostics.

The host MUST return `indeterminate` or `deny` for stale, missing, malformed, unsupported,
incomplete, cancelled, timed-out, crashed, unavailable, incompatible, quarantined, errored,
missing-authority, insufficient-assurance, direct-write-risk, policy-self-authorization, or degraded
required coverage. These states MUST be machine-readable in `coverage.degraded` and the host receipt
`failures[]` with capability/provider-state context where provider lifecycle caused the degradation,
and MUST NOT silently become `allow`.

Unsupported required capability and provider runtime error are distinct degraded reasons. Optional
provider degradation can be visible, but it cannot masquerade as complete required coverage.

## Core Adoption Gate

An implementation has adopted ASP Core v1.0 only when a private harness can produce fresh evidence
for the full Core path:

- `host/status` reports a ready or explicitly degraded host state with active policy identity,
  baseline, required check coverage, provider lifecycle/capability health, and a private
  host-authored receipt.
- `host/capabilities` reports composed host capabilities where `check` is available for Core and
  `inspect`/`edit` are not required to adopt Core; degraded optional provider capability health stays
  visible without satisfying or blocking required coverage by itself, and the response carries the
  same private receipt vocabulary as status/evaluate.
- Every provider that satisfies required coverage has completed `initialize` and has accepted the
  narrowed `initialized` grant.
- Required providers can evaluate a host-issued `SnapshotRef` / `Baseline` plus immutable
  content-addressed `ChangeSet` through `check/evaluate`.
- Provider content access is limited to `workspace/readBlob` and `workspace/listTree` under the host
  grant.
- `host/evaluateChangeset` produces host Decision envelopes for allow, deny, and negative
  indeterminate cases.
- Missing provider, stale assessment, malformed provider output, unsupported required capability,
  incomplete assessment, cancellation, timeout, crash, unavailable provider, incompatible provider,
  quarantine, provider error, missing authority, insufficient assurance, direct-write risk, policy
  self-authorization, and degraded required coverage are represented as non-passing host Decisions
  when required.
- Existing private guardrails remain retained during any shadow or pilot phase until separate
  replacement criteria are accepted.

Core adoption evidence is private implementation evidence. It is not certification, registry
membership, public standard status, release approval, or package stability.

## Core Adoption Receipt

A Core adoption receipt is a host-authored evidence bundle. It MUST include:

- the `host/status` receipt;
- the composed `host/capabilities` receipt or equivalent host-authored capability evidence;
- initialized grant evidence for each required provider;
- allow, deny, and negative `host/evaluateChangeset` receipts;
- `policyDigest`;
- `baseline` / `SnapshotRef`;
- `validAsOf`;
- decision coverage with `coverage.required`, `coverage.ran`, and `coverage.degraded`;
- authority evidence for required providers;
- achieved assurance mode and transaction guarantee;
- request digest, provider ids, timing, failure entries, and private/experimental/non-trust-artifact
  flags on every host receipt;
- a retained-guardrail statement for the private shadow or pilot phase.

The receipt is valid only for the referenced policy, baseline, changeset, provider identity,
provider integrity, conformance evidence, authority grant, and assurance mode.

## Optional Non-Core Profiles

The following are explicitly non-Core for v1.0 adoption:

- inspect capability and `host/queryInspect`;
- edit capability and `host/requestEditPlan`;
- apply capability and `host/applyProposal`;
- manager daemon, setup wizard, agent-root hooks/skills, and server catalog;
- deployment manifests and local policy files;
- dogfood migration;
- ACE integration;
- reference-engine parity.

Optional profiles can depend on Core, but failure to implement them does not block the Core adoption
gate. They also cannot be used to bypass the Core host/provider/check path for blocking gates.

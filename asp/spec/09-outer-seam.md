---
title: Outer seam (harness <-> conforming host)
status: draft
normative: true
summary: The harness-facing ASP semantic contract: status, capability aggregation, evaluation, inspect, edit plans, apply intent, authority, audit receipts, assurance modes, and deployment-surface evidence.
updated: 2026-06-24
---

# Outer seam (harness <-> conforming host)

The outer seam is the contract an agent harness, editor integration, CI runner, or repository hook
binds to. The inner seam (`host <-> server`) lets multiple robustness engines plug in. The outer seam
is how a harness gets one coherent decision surface without knowing which providers are loaded.

ASP treats this as a semantic contract first. [ADR 0025](../decisions/0025-asp-binding-bakeoff.md)
chooses native JSON-RPC over stdio as the private dogfood binding floor. A namespaced MCP extension
remains a private compatibility/status experiment until it proves the same host-owned semantics. ACP
remains an editor-agent integration layer, not the source of gate authority. Ordinary MCP tools are
not authoritative gates.

- **ASP semantic outer seam** is the required host-facing model for robustness gating, edit mediation,
  provenance, and policy.
- **Private MCP extension experiment** may carry these semantics only if it preserves host decisions,
  call-sites, authority, assurance modes, cancellation, terminal-result authority, and mediated apply
  without reducing them to model-controlled tools.
- **ACP adapters** can connect editor or IDE agents to a host or harness, but host decisions remain
  authoritative and ACP does not supply gate authority.

## 1. Topology

The harness talks to a conforming ASP host. The host talks to enrolled ASP servers. A harness MUST NOT
call a server directly for a blocking gate, write transaction, or authority decision.

```text
harness / CI / hook
        |
        | ASP semantic outer seam
        v
conforming ASP host
        |
        | ASP inner seam
        v
inspect / check / edit providers
```

The first Open Engine implementation is expected to be:

- reference/default manager and host runtime: `@the-open-engine/asp` / `asp`;
- reference engine/server: Lattice, enrolled as one multi-capability ASP server (`inspect`, `check`,
  `edit`), not ASP, not the manager, not the host, and not the protocol.

That implementation shape is not part of the semantic contract. Other hosts and servers can conform
if they honor the same private draft semantics and conformance tests. Other managers can also exist;
the Open Engine manager is intended to make installation, server discovery, agent-root setup, and
repo enrollment easy, not to become a required central service.

There is no Lattice-specific outer seam. A harness path that asks Lattice directly for a gate
decision, freshness override, authority grant, or write transaction is non-conforming; Lattice must
be enrolled behind the host exactly like fake and third-party providers.

Host acquisition, repository policy, local overrides, installed manifests, trusted launch config, and
authority grants are separate deployment surfaces defined in
[`spec/10-installation-and-discovery.md`](./10-installation-and-discovery.md). The outer seam consumes
their resolved state; it does not let a harness, candidate policy, or provider shortcut that state.
ACE, editors, CI jobs, repository hooks, and agent loops are all possible harnesses. None is required
for ASP delivery, and none becomes the carrier for ASP or Lattice merely by consuming this outer seam.
Harness creators should be able to integrate ASP by speaking this seam directly, by using an SDK, or
by calling a local manager daemon; none of those paths may bypass host-owned decisions or provider
authority checks.

## 2. Private binding floor and adapters

The current private native dogfood floor is JSON-RPC 2.0 over stdio:

```sh
asp host serve --repo <workspace>
```

The namespaced MCP-extension experiment must keep using the same semantic host surface and must not
be treated as authoritative until a later ADR proves required host invocation, call-site preservation,
freshness equality, coverage, authority, assurance, cancellation receipts, and mediated apply.
Ordinary MCP tools MAY expose read-only status, inspect, or debugging adapters, but they MUST NOT
satisfy a blocking `gate` call-site. A future socket, editor service, or platform service MUST be
semantically equivalent to the JSON-RPC stdio floor and MUST NOT add policy-only behavior unavailable
through that floor.

Exact method strings and envelopes can vary by binding adapter. The semantic obligations below do
not.

## 3. Semantic host method surface

The outer seam starts with these host method families. Names are descriptive; exact candidate-binding
method strings and payload schemas live in
[`schemas/outer-host.schema.json`](../schemas/outer-host.schema.json).

| Method family | Required semantics | Required for |
|---|---|---|
| `host/status` | Report host readiness, private binding candidate, policy source and digest, local override presence, required/enrolled providers, manifest/access evidence, `coverage.required`/`ran`/`degraded`, current baseline, gate availability, available assurance modes, policy activation, and receipt data. | all hosts |
| `host/capabilities` | Return the host-composed `inspect`, `check`, and `edit` surface after policy, provider health, authority, and call-site checks. Legacy `sense`, `judge`, and `act` aliases are compatibility labels only. | all hosts |
| `host/evaluateChangeset` | Evaluate a candidate `SnapshotRef`/`ChangeSet` and return a host-produced decision envelope. Provider assessments are inputs; the host rejects stale or malformed assessments and only the host returns `allow`, `deny`, or `indeterminate` to the harness. | gates |
| `host/queryInspect` | Run a read-only inspect request through enrolled providers with host-owned freshness, policy, and degraded-state reporting. Missing or stale required inspect coverage is not an empty result. | `inspect` |
| `host/requestEditPlan` | Ask edit-capable providers for a canonical `EditPlan` bound to the host baseline. No files are written and no apply authority is implied. | `edit` |
| `host/applyProposal` | Accept authorized user, agent, or harness apply/stage intent; validate the proposal through host policy; refuse denied/indeterminate/stale/conflicting proposals; mediate or stage allowed edits; return the achieved assurance mode, transaction guarantee, and apply receipt. | mediated writes |
| `host/authority/status` | Expose provider identity, integrity, conformance, isolation, authority grants, enrollment state, policy activation, manifest/access evidence, degraded state, and missing/quarantined/incompatible provider states without treating manifests as trust. | gates |

The [Core Profile](./11-core-profile.md) uses only `host/status`, `host/capabilities`, and
`host/evaluateChangeset` as the tiny first harness-facing path. Inspect, edit, apply, deployment
surfaces, dogfood, ACE integration, and reference-engine parity are optional non-Core profiles.

Every evaluation surfaced to a harness MUST use a host-produced decision envelope. The legacy
`verdict` schema remains a transitional envelope name, but servers return assessments, not verdicts.
Status and authority surfaces MUST identify the active policy source, candidate-policy activation
state, local override presence, manifest path and state, whether access expectations were declared,
provider authority evidence, required/ran/degraded coverage, degraded provider state, and per-call-site
gate availability.

If a provider assessment contains host-owned pass/fail, decision, verdict, disposition, authority,
assurance, or transaction fields, the host treats it as malformed inner-seam data and exposes
degraded coverage rather than passing it through as a gate result.

The same rule applies to edit provider output. Provider `EditPlan` data is proposal-only. It cannot
carry shell commands, arbitrary scripts, command arrays, patch shellouts, host decisions, verdict
envelopes, authority grants, achieved assurance modes, or transaction guarantees as authoritative
mutation or gate data.

Servers also do not expose `host/*` methods. Provider methods stay on the inner seam and cannot be
used as a substitute for host status, gate evaluation, apply, or authority status.

## 4. Receipts and auditability

`host/status`, `host/capabilities`, `host/evaluateChangeset`, `host/queryInspect`,
`host/requestEditPlan`, `host/applyProposal`, and `host/authority/status` responses carry private
host-authored audit receipts. Gate and apply receipts MUST preserve:

- `receiptId`;
- `issuedAt`;
- `kind` (`status`, `capabilities`, `evaluate`, `inspect`, `edit-request`, `apply-attempt`,
  `authority-status`, or `provider-failure`);
- host identity, canonical capability family, call-site when relevant, request digest, and changeset
  digest or proposal id when relevant;
- provider ids plus provider provenance for every contributing assessment or edit plan;
- `policyDigest` or an equivalent immutable policy identity;
- baseline and `validAsOf` freshness evidence;
- provider coverage, including `required`, `ran`, `degraded`, and optional degradation;
- explicit failure entries mirroring degraded coverage;
- authority evidence across identity, integrity, conformance, isolation, and authority grant;
- achieved `assurance.mode`;
- achieved `transactionGuarantee` for apply/stage, never stronger than the host can enforce;
- `privateOnly: true`, `experimental: true`, and `trustArtifact: false`.

Receipts are host-authored records. A provider can contribute provenance, assessment details, and edit
plans, but it cannot mint an authoritative gate or apply receipt.

## 5. Capability aggregation

The host returns a single composed capability surface. Aggregation is conservative:

- A capability is available only when at least one enrolled provider for that capability is healthy
  enough for the current call-site and authority requirements.
- A blocking gate is available only when every required authorized provider for that call-site can
  run to a complete assessment; otherwise the host produces an explicit `indeterminate` or `deny`
  decision.
- Optional providers can improve coverage but cannot satisfy or weaken gates unless policy grants
  authority.
- Conflicting capabilities are resolved by host policy and authority grants; the host MUST surface the
  resolved provider list and degradation in `host/status`, `host/capabilities`, or decision coverage.

The host never exposes a raw union that lets a provider silently become a blocking authority.

## 6. Call-sites and gate fail policy

Outer seam requests MUST identify the call-site:

- `interactive` for editor or agent-loop feedback;
- `gate` for commit, pre-write, CI, or ship blockers;
- `sweep` for background or scheduled repository scans.

The host applies policy from [`spec/07-host-obligations.md`](./07-host-obligations.md). For a `gate`
call-site, the host MAY return `allow` only when all of the following are true:

- every `coverage.required` provider/capability has complete authorized coverage and appears in
  `coverage.ran`;
- the candidate baseline, changeset digest, and provider-read blob set match the host-issued
  freshness evidence;
- all required provider responses use compatible protocol/schema versions;
- no required assessment is stale, missing, malformed, unsupported, incomplete, cancelled, timed out,
  quarantined, or errored;
- every required authority grant is present and active;
- achieved assurance mode satisfies the call-site requirement;
- no authorized gating finding remains after host arbitration.

Missing host, missing required provider, unavailable provider, quarantined provider, incompatible
provider, schema mismatch, policy mismatch, stale baseline or stale check `validAsOf`, policy
self-authorization, direct-write risk, Lattice fast path, unsupported required capability,
unsupported assurance mode, missing authority, insufficient assurance, timeout, incomplete response,
malformed response, provider cancellation, or provider error MUST produce explicit degraded coverage
plus `indeterminate` or `deny` decisions for `gate` call-sites. Unsupported coverage and provider
runtime errors remain distinguishable. Optional-provider degradation MUST be visible in coverage and
MUST NOT masquerade as complete required coverage.

Advisory or non-authorized findings are visible inputs. They do not satisfy a named requirement and do
not block a gate by themselves.

## 7. Apply authorization

An authorized harness, user, or agent request to `host/applyProposal` is sufficient protocol-level
intent for the host to attempt mediated apply. The host MUST report the achieved assurance mode,
transaction guarantee, receipt, baseline before/after, and policy decision used for the apply.
[ADR 0024](../decisions/0024-supersede-server-initiated-apply-edit.md)
supersedes the older server-initiated `applyEdit` branch; the conforming outer seam has no
server-owned apply method.

That does not grant autonomy to servers:

- servers propose edit plans;
- the host checks freshness, scope, preconditions, proposal blobs, text edit applicability, conflict
  state, policy, authority, and required check coverage;
- denied or required indeterminate validation returns `applied:false` with `baselineAfter:null`;
- stale or conflicting proposals return explicit refusal data and do not force-overwrite local
  changes;
- the host applies or stages only allowed edits according to its achievable guarantee;
- a background server notification cannot trigger a write by itself;
- autonomous server-triggered writes are forbidden unless a future ADR defines a new opt-in mode.

For internal dogfood, this means an agent harness can ask a conforming host to apply Lattice
proposals in Open Engine repos, but Lattice itself still has no direct write authority in a mediated
or isolated deployment.

Claims of `mediated-write`, `isolated`, direct-write prevention, or atomic workspace mutation require
an enforceable deployment mechanism. Schema shape or protocol text alone is not evidence.

## 8. Policy activation

Policy changes are two-phase:

1. A branch or pull request is evaluated under the trusted base policy already active for the target
   branch or a non-weakenable organization floor.
2. If the policy change is accepted, the new policy activates only after merge or an explicit trusted
   approval event.

A proposed policy change MUST NOT weaken gates for the same change that introduces it. The trusted
base policy, or an organization-level non-weakenable floor, remains authoritative for the candidate.
Providers cannot bypass this by being called directly: direct provider calls never satisfy blocking
gates, authority decisions, or mediated writes.

## 9. Adapter profiles

Adapters are profiles over the ASP semantic seam:

- An MCP adapter MAY be read-only inspect/status tooling, or a private extension experiment if it
  faithfully preserves decisions, call-sites, authority, assurance modes, cancellation, terminal
  result authority, and apply receipts.
- Ordinary MCP tools are insufficient for authoritative gates when the model, rather than the host,
  controls whether and how a tool is called. They are rejected for blocking `gate` call-sites by
  ADR 0025 unless wrapped by a later host-controlled profile accepted by ADR.
- An ACP adapter MAY map editor-agent requests to the outer seam, but gate decisions remain host
  decisions and ACP cannot grant provider authority.
- A legacy harness adapter MAY translate its hook protocol to `host/evaluateChangeset` and
  `host/applyProposal`, but it MUST NOT provision providers directly for blocking gates or bypass the
  host.
- An ACE adapter MAY be a thin host-client adapter over a configured conforming host, but ACE MUST
  NOT be treated as the ASP distribution mechanism, ASP release gate, host startup authority, provider
  authority, or Lattice provisioning path.

Adapters are useful distribution paths. They are not a substitute for the ASP host contract.

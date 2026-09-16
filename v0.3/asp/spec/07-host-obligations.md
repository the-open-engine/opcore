---
title: Host obligations
status: established
normative: true
summary: Assessment aggregation, provider supervision, decision computation, policy-pinned authority grants, fail-policy, freshness, arbitration, mediated apply, assurance modes, budgets, and dogfood reporting.
updated: 2026-06-25
---

# Host obligations

The host is where ASP's guarantees actually live. Servers report assessments and edit plans; the host
decides.

The [Core Profile](./11-core-profile.md) narrows these obligations to the tiny first
host/provider/check path: status, composed capabilities, initialized grants, blob/tree callbacks,
provider Assessments, and host Decisions. Inspect, edit, apply, deployment surfaces, dogfood, ACE
integration, and reference-engine parity remain optional non-Core profiles.

## 1. Decision computation and gate authority

A check-capable server returns an **assessment**: status, diagnostics/evidence, coverage, freshness
binding, and provider metadata. It never returns the authoritative policy result. The host derives the
**decision**.

Assessment shape is provider-owned only. If a check provider returns a pass/fail projection, host
decision, verdict envelope, finding disposition, authority grant, assurance mode, or transaction
guarantee, the host MUST treat the response as malformed contract data and surface degraded coverage.

Two host-owned concepts govern whether a finding blocks:

- **Authority grant.** A `check/*` capability means a provider can evaluate. Whether its assessment
  satisfies a gate is a trusted-policy decision. Authority MUST be granted to a pinned provider
  identity/version/digest for a named requirement and named call-site. Certification, provenance,
  first-party labels, package scope, repository config, local overrides, and installed manifests cannot
  satisfy a gate without that trusted policy grant.
- **Effective severity.** The host MAY cap or reinterpret provider self-reported severity by
  authority, isolation, and policy. This is presentation and policy logic; it is not conformance.

```text
required        = host.requiredRequirements(callSite)
assessments     = host.collectAssessments(required)
coverage        = { required, ran: host.completedSources(assessments),
                    degraded: host.degradedSources(required, assessments) }
blocking        = [ d in assessments.diagnostics
                    if host.effectiveSeverity(d, providerAuthority) == "error" ]
decision        = allow only when every coverage.required entry is in coverage.ran
                  AND coverage.degraded is empty for required coverage
                  AND blocking is empty
                  AND no required assessment is stale, missing, malformed,
                      unsupported, incomplete, cancelled, timed out,
                      quarantined, or errored
                  AND authority evidence is present for every required provider
                  AND achieved assurance satisfies the call-site
```

When several providers run on one changeset, the decision is conservative: the change is allowed only
if every required authorized provider satisfies its requirement after arbitration (§4). Missing or
incomplete required coverage produces `indeterminate` or `deny` according to call-site policy.

### Authority axes

The host tracks five independent axes for every provider, aligned with
[the governance draft](../docs/governance/governance-draft.md):

| Axis | Meaning |
|---|---|
| Identity | Who published or owns the provider. |
| Integrity | Which exact artifact/package digest is running. |
| Conformance | Whether the provider implements ASP correctly. |
| Isolation | What the provider can read, write, execute, or transmit. |
| Authority | Whether policy allows the provider to satisfy a named gate. |

Older labels such as `first-party`, `certified`, and `untrusted` are shorthand only and MUST NOT grant
authority by themselves.

### Decision envelope

The host packages every evaluation it surfaces to the harness/user as a **verdict object**
([`schemas/verdict.schema.json`](../schemas/verdict.schema.json)). `verdict` is a legacy envelope name
for a host-produced decision; servers return assessments, not verdicts. The host MUST:

- set the **`callSite`** (`interactive` | `gate` | `sweep`) so the developer can tell a hard block
  from a warn-allow;
- stamp every finding with host-authenticated **provenance** (`diagnostic.source`) and authority
  evidence, and mark each finding's **`disposition`** (`gating` | `advisory`);
- when it caps a finding's effective severity below the server's self-report, set **`severityNote`**
  so the downgrade is legible;
- guarantee a **`nextStep`** on every gating finding from the server's `fix`/`help`/
  `codeDescription.href`, or a host-synthesized fallback when the server gave none;
- include **every gating finding** in `findings`; advisory inclusion is host policy;
- report **`coverage`**: `required` sources, which `ran`, and a **`degraded`** list naming any
  provider that failed open, was quarantined, skewed/incompatible, missing, unavailable, stale,
  unsupported, malformed, incomplete, cancelled, crashed, timed out, errored, missing authority, or
  insufficiently assured; provider degradation SHOULD include `capability` and `providerState`;
- report **`policyDigest`** or equivalent immutable policy identity;
- report provider **authority evidence** across identity, integrity, conformance, isolation, and
  authority grant;
- report the achieved **assurance mode** and transaction guarantee when apply is involved;
- attach or enable reconstruction of an **audit receipt** preserving provenance, policy digest,
  baseline/`validAsOf`, coverage, authority evidence, assurance mode, and transaction guarantee.

The decision envelope is how provenance, advisory-vs-gating, next-step, assurance, receipts, and
degraded coverage reach the developer. Its rendering stays outer-seam.

## 2. Fail-policy

When a required provider is absent, unavailable, quarantined, incompatible, stale, malformed,
unsupported, or exceeds its budget (§8), the host decides open vs closed from the typed failure and
the **call-site** — never from the provider. The canonical call-sites are `interactive`, `gate`, and
`sweep`.

Provider `status:"unsupported"` is a capability gap, not a provider/runtime failure. Provider
`status:"error"` means the provider attempted evaluation and failed. The host MUST keep these
distinct for routing, metrics, user display, and coverage degradation, while ensuring neither silently
satisfies required gate coverage.

| failClass | interactive edit | commit / ship gate |
|---|---|---|
| `health` (could not run / timed out) | fail open (warn, allow) | indeterminate/deny by policy |
| `contract` (ran wrong / version skew) | fail closed | fail closed |
| `policy` / `input` | fail closed | fail closed |

The host MUST log every fail-open with provider id, `failClass`, and call-site. Silent fail-open is
forbidden. Missing required coverage, stale baselines, malformed responses, unsupported required
capabilities, incomplete responses, cancellations, provider errors, timeouts, quarantined providers,
missing authority, and insufficient assurance MUST be visible as degraded coverage plus
`indeterminate` or `deny` for gates, never as a pass.

For `gate` call-sites, the following conditions MUST produce `indeterminate` or `deny`; they MUST NOT
be rendered as `allow`: missing conforming host, incompatible host, missing required provider, stale
baseline, stale/malformed/incompatible manifest, timeout, schema mismatch, missing authority,
unsupported required capability, insufficient assurance mode, and provider quarantine. Optional
provider loss may reduce coverage, but optional degradation MUST NOT be reported as full required
coverage.

The decision envelope's
`coverage.degraded[]` entry MUST identify the provider or requirement and use the corresponding
degradation reason from
[`schemas/assurance.schema.json`](../schemas/assurance.schema.json).

### Provider supervision

The host owns provider launch and lifecycle supervision. Repository policy is logical input only and
MUST NOT supply executable paths, shell strings, scripts, working directories, or environment
mutation for provider startup. Where launch metadata exists, it must come from trusted installed or
environment configuration and use structured executable plus argv arrays; shell-string startup is not
a conforming gate path. Installed manifest executables MUST be absolute paths, and manifest launches
MUST use a trusted manager/artifact working directory rather than the mutable candidate repository.

The host MUST track provider lifecycle states visibly: launched, initializing, initialized, active,
cancelled, shutting down, exited, crashed, timed out, incompatible, malformed, unavailable,
quarantined, and degraded. `host/status`, `host/capabilities`, and evaluation receipts MUST expose
provider state per provider and per capability family (`inspect`, `check`, `edit`). Legacy
`sense`/`judge`/`act` labels may appear only as compatibility aliases.

Provider metadata, installed provenance, catalog membership, conformance evidence, first-party
labels, local install state, and manifest presence are evidence only. None of them grants gate
authority without explicit trusted policy over identity, integrity, isolation, requirement, and
call-site. Lattice, fake providers, community providers, paid providers, closed-source providers, and
local-dev providers all travel through the same supervisor/router boundary.

## 3. Assurance enforcement

The host MUST report the actual assurance mode achieved for each decision:

| Mode | Actual guarantee |
|---|---|
| `advisory` | Host can run/report checks but cannot enforce a boundary. |
| `gated` | Host controls a commit, merge, CI, or similar boundary. |
| `mediated-write` | Intended writes pass through the host. |
| `isolated` | Server cannot write the real worktree and has constrained data/network access. |

Protocol text cannot by itself stop a local subprocess from writing files. A claim of
`mediated-write` or `isolated` requires an enforceable deployment mechanism such as a read-only
snapshot mount, host-provided content API, copy-on-write overlay, container, OS sandbox, or equivalent
worktree write denial.

If server code can write the real worktree directly, the host MUST report `advisory` or `gated`, mark
the relevant coverage or apply receipt with `direct-write-risk`, and avoid any transaction guarantee
stronger than it can enforce. A local direct-write deployment cannot claim `mediated-write`,
`isolated`, `workspace_transactional`, or `staged_snapshot` solely because the protocol describes
proposal and apply messages.

## 4. Arbitration

Multiple providers may hold the same capability. The host reconciles before producing a decision:

- **Dedup within a source by fingerprint; across sources, host-canonicalized.** A `fingerprint` is
  authoritative only within its `diagnosticSource`; cross-server fingerprint equality MUST NOT affect
  the gate decision.
- **Precedence per requirement, by authority grant.** When two providers covering the same required
  source conflict, the provider authorized for that requirement wins; ties surface both and produce
  an indeterminate/deny decision on a gate.
- **Conflicting edits.** Two edit proposals touching overlapping blobs MUST NOT both apply. The host
  serializes: apply one, re-baseline, re-propose the other against the new baseline, or reject.
- **Source ownership.** A server MUST only emit diagnostics whose `code` is namespaced under a
  `diagnosticSource` it declared at initialize; the host MUST drop or relabel others.
- **Coverage.** The host MUST record which diagnostic sources and requirements ran so a missing
  provider reduces coverage visibly rather than silently.

## 5. Freshness authority

The host is the sole issuer of baselines and the sole authority for staleness.

- Every provider request carries the host's current baseline; every response echoes `validAsOf`.
- The host MUST reject, downgrade, or re-issue any response whose `validAsOf` does not equal the
  request baseline, changeset digest, and provider-read blob set.
- A stale assessment MUST NOT contribute to an `allow` decision. If a stale response cannot be
  re-issued before the budget expires, the host records degraded coverage with reason
  `stale` and returns `indeterminate` or `deny` for a `gate` call-site.
- Because changesets and blobs are content-addressed ([data model](./03-data-model.md)), staleness is
  exact in the private binding. Future public bindings may standardize only the observable invariant:
  immutable snapshot identity and per-resource preconditions.
- The host owns the watch/refresh loop. Servers bind to the baseline the host gives them; they do not
  re-derive freshness.

## 6. Mediated apply

Edit-capable servers propose; the host applies or stages. The host MUST report the achieved
transaction guarantee and an apply receipt:

| Guarantee | Meaning |
|---|---|
| `none` | No atomicity or rollback guarantee. |
| `rollback_attempted` | Host attempted restoration after failure. |
| `text_only_transactional` | Text edits are all-or-nothing within declared constraints. |
| `workspace_transactional` | Workspace mutation is atomic within declared constraints. |
| `staged_snapshot` | Host produced a candidate snapshot/tree before publishing it. |

The default mediated flow:

```text
1. edit/propose                      -> workspaceEdit/EditPlan (bound to baseline B)
2. host normalizes hypothetical changeset = B + workspaceEdit
3. host runs required checks on the hypothetical change
4. allow -> apply/stage according to reported guarantee; issue new baseline B'
   deny/indeterminate -> reject; nothing intentional is written
5. if B moved in a touched path, 3-way merge or re-propose, bounded to N retries, then reject
```

The apply receipt MUST include proposal id, baseline before/after, validation decision, policy digest,
provider provenance, authority evidence, achieved assurance mode, and the transaction guarantee
actually achieved.

Before apply, the host MUST reject or mark indeterminate any edit provider output that is not a
structured `EditPlan`: shell commands, arbitrary scripts, command arrays, patch shellouts, missing
preconditions, missing proposal blobs, unsupported operations, stale `validAsOf`, baseline mismatch,
touched-path drift, host-owned decision fields, or provider-claimed transaction guarantees. Denied or
required indeterminate validation over the hypothetical after-state prevents apply and returns
`applied:false`; `baselineAfter` remains null because no intentional workspace mutation is published.

The host MUST NOT claim a stronger guarantee than it can enforce. Ordinary worktrees may only support
`rollback_attempted` or `text_only_transactional`; overlays or staged snapshots may support stronger
guarantees. Server code has no direct write authority in mediated-write or isolated assurance modes.

A fix or edit plan is applied only on explicit agent, harness, or user action; the host MUST NOT
auto-apply background server notifications.

Authorized `host/applyProposal` intent is sufficient protocol-level write intent for the host to
attempt a mediated transaction. It is not authority for a provider to write directly, schedule a
background write, or bypass re-validation of the proposed changeset. Server-initiated `applyEdit` is
not a conforming write path; [ADR 0024](../decisions/0024-supersede-server-initiated-apply-edit.md)
supersedes that branch while preserving serialized host apply semantics.

## 7. Policy activation and self-authorization

Policy edits are evaluated under **BasePolicyAuthority**: the trusted base policy already active for
the target branch, plus any organization-level non-weakenable floor. Candidate policy may be parsed and
reported as pending, but it MUST NOT authorize the same changeset that introduces it, add a new
provider as blocking authority for that changeset, or weaken the required gate set for that changeset.

When a candidate policy tries to authorize its own provider, lower assurance, weaken a gate, or select
a privileged host implementation, the host MUST record degraded coverage with reason
`policy-self-authorization` and return `indeterminate` or `deny` for a `gate` call-site.

## 8. Budgets and quarantine

A single provider MUST NOT be able to stall the loop or block by attrition.

- The host applies a per-call-site timeout. A timeout is a `health` failure and follows the §2 policy.
- A provider that repeatedly fails health or exceeds budget MAY be quarantined, and the event MUST be
  surfaced as reduced coverage, never as a silent pass.
- The interactive budget is a whole-host ceiling, not per-provider.
- The host MUST bound server-to-host callbacks per request/session and provider response sizes.
- The host MUST emit per-provider health, latency, and coverage metrics so degradation is visible.

## 9. Dogfood reporting

When a host reports ASP dogfood runs for a reference engine/server such as Lattice, it MUST preserve
host-owned and per-capability evidence instead of collapsing the run into a single pass/fail label.
Reports MUST include:

- parity deltas by capability and predecessor baseline: `inspect` versus CRG graph/search/impact/
  watch/WAL/hot-query and relevant CIX read-only symbol routes; `check` versus Rox TypeScript, Rust,
  custom-extension, daemon/cache, scope, and pre-write/hypothetical behavior; `edit` versus CIX
  exact, multi, search-replace, patch, tree, rename, move, signature, and validation-before-write
  behavior;
- false positives and false negatives with samples tied to check ids, predecessor findings, or
  receipts;
- latency by call-site and capability, including p50, p95, timeout counts, and interactive/gate/sweep
  context;
- stale rejections and freshness failures, including baseline or `validAsOf` mismatches and any graph
  freshness mismatch;
- typed failures by capability: crash, timeout, daemon unavailable, schema mismatch, missing
  provider, unsupported mode, provider error, malformed output, invalid payload, and missing
  authority;
- degraded coverage, including skipped providers, unsupported language/check/edit surfaces,
  quarantined providers, lower-than-required assurance, and retained old-tool compatibility gates;
- edit conflicts and refused edits, including checksum conflicts, overlapping edits, path-policy
  refusals, validation failures, unsafe patches, unsupported binary edits, and stale graph/edit
  evidence;
- rollback or staging outcome for any apply path: no write, rollback attempted,
  text-only transactional, workspace transactional, or staged snapshot;
- achieved assurance mode and actual transaction guarantee as reported by the host;
- old-tool compatibility status per protected surface: native provider, ASP provider compatibility,
  retained old-tool compatibility gate, explicit de-scope, or roadmap;
- referenced release evidence such as descriptor artifact, graph release receipt, release receipt,
  cutover receipt, provenance report, license report, secret scan report, and supported-platform
  notes when those artifacts are used as readiness inputs.

The host MUST keep graph/inspect, validation/check, and edit degradation independently visible. A
provider-side validation result, edit apply receipt, descriptor, or release receipt is not a host
decision and cannot prove an achieved assurance mode or transaction guarantee without host evidence.

## Implementation-defined

- Exact effective-severity and fail-class reclassification tables.
- Concrete timeout, quarantine, callback-budget, and resource-limit values.
- Concrete sandbox and isolation mechanism for each assurance mode.
- Concrete staged apply, transaction, merge, and retry strategies.

---
title: Glossary
status: established
normative: true
summary: Canonical ASP terminology, including manager, host, server, assessment/decision, capability, assurance, and authority terms.
updated: 2026-06-25
---

# Glossary

The single source of truth for ASP terminology. Use these exact terms in spec, code, and docs.

## First-reader glossary

- **ASP manager** — the installed `asp` CLI/daemon that helps users install, enroll, supervise, and
  inspect ASP servers. The manager is a product/distribution layer; it is not the protocol itself.
- **Host** — the coordinator the agent or harness calls. It asks providers/servers for work and
  returns decisions and receipts.
- **Provider/server** — a robustness engine enrolled behind the host. It produces assessments or edit
  plans; it does not decide whether a gate passes.
- **Harness** — the agent loop, editor integration, hook, or CI runner that calls the host.
- **inspect** — read-only code intelligence, such as references, impact, and flows.
- **check** — evaluation of a candidate change. A check provider returns an assessment.
- **edit** — a proposed edit plan. The host decides whether and how it may be applied.
- **Assessment** — provider/server output from a check.
- **Decision** — host output: `allow`, `deny`, or `indeterminate`.
- **Receipt** — host-authored evidence for a status, evaluation, apply, or authority response.

Stop here if you only need the mental model. The protocol glossary below is for spec,
implementation, and conformance work.

## Protocol glossary

### Core nouns

- **ASP manager** — an implementation and ecosystem layer that installs, discovers, configures,
  supervises, and reports on ASP servers for a developer, organization, or harness. The first Open
  Engine manager is expected to be the installed `asp` CLI/daemon. A manager may also embed or launch
  a conforming host, but "manager" is not a normative protocol role and other conforming hosts or
  managers remain valid.
- **Host** — the conforming coordinator role. It owns capability negotiation, freshness, policy,
  assessment aggregation, decisions, authority status, assurance reporting, transaction guarantees,
  and mediated apply. It can be embedded in a harness/editor/CI system or supplied by the Open Engine
  reference/default host implementation behind the `asp` manager.
- **Server** — a pluggable guardian provider. It advertises capabilities and returns assessments or
  edit plans. A single server can advertise multiple capability families, such as Opcore exposing
  `inspect`, `check`, and `edit`, without becoming the host. We say "server," not "daemon":
  "daemon" is the process, "server" is the provider role it plays in the protocol.
- **Server catalog** — a manager-facing discovery surface for installable ASP servers. Catalog
  listing can help users find servers, but listing, "official" support, paid distribution, or
  community status never grants gate authority by itself.
- **Official-supported server** — an ASP server that Open Engine chooses to document, test, or support
  in the manager. Opcore is expected to be the first such server. Official support is not automatic
  authority for shared gates.
- **Community-listed server** — an ASP server referenced by docs or a catalog because it may be useful
  to users. It can be conformant or non-conformant, open or closed, free or paid; it still needs
  explicit identity, integrity, conformance, isolation, and authority evidence before it can satisfy a
  gate.
- **Local-dev server** — an unpublished or locally linked ASP server used for experiments. It is
  advisory by default and cannot satisfy shared gates unless trusted policy explicitly grants
  authority.
- **Reference engine/server** — a non-mandatory implementation used to prove ASP behavior. Opcore is
  the intended first Open Engine reference engine/server for the provider side and one official
  supported ASP server option. It is not ASP, not the host, not the manager, and not privileged over
  third-party providers.
- **Harness** — the agent loop (editor-agent, CI runner, pre-commit) that drives edits and consumes
  host decisions.
- **Outer seam** — the harness-to-host ASP semantic contract. It covers host status, composed
  capabilities, changeset evaluation, inspect queries, edit plans, apply intent, apply receipts, and
  authority status. Native JSON-RPC over stdio is the private dogfood binding floor; a namespaced
  MCP extension remains a private compatibility/status experiment.
- **Inner seam** — the host-to-server ASP contract for provider capabilities.
- **Repository policy** — a versioned logical-only policy file. It declares ASP version, required
  assurances, capabilities, pinned provider identity/version/digest/conformance, gates, budgets, and
  adapters, but it does not choose a host implementation, launch providers, or contain blocking gate
  commands. `.asp/asp.json` is experimental and is not a trust root or authority grant by itself.
- **Local override** — ignored `.asp/local.json` policy for local advisory experiments, presentation
  preferences, and unpublished builds. It cannot certify a server, weaken shared gates, grant shared
  authority, or produce shared authoritative decisions.
- **Server manifest** — installed `asp-server.json` metadata for a server artifact: id, version,
  capabilities, capability profiles, structured entrypoint, fingerprints, provenance, and explicit
  access expectations. It is a private experimental launch hint, not trust or authority.
- **Provider lifecycle state** — host-observed process/protocol state for an enrolled provider:
  launched, initializing, initialized, active, cancelled, shutting down, exited, crashed, timed out,
  incompatible, malformed, unavailable, quarantined, or degraded. Lifecycle state is evidence for
  coverage and status; it is not authority.
- **Provider capability health** — per-provider, per-capability availability for `inspect`, `check`,
  and `edit`, including advertised support, lifecycle state, and typed degradation. A failed `check`
  capability must not be collapsed into vague whole-host failure.
- **Deployment surface** — an experimental file, manifest, adapter, or launch context that helps a
  host find policy or providers. Deployment surfaces are not the semantic standard unless a later ADR
  promotes one.
- **Core Profile** — the tiny private ASP v1.0 host/provider/check capability profile:
  `host/status`, `host/capabilities`, `host/evaluateChangeset`, `initialize`/`initialized`,
  `workspace/readBlob`, `workspace/listTree`, `check/evaluate`, `SnapshotRef`/`Baseline`,
  `ChangeSet`, provider `Assessment`, host `Decision`, and decision `coverage.required`/`ran`/
  `degraded`.
- **Core adoption gate** — the private evidence gate for claiming "ASP Core v1.0 adopted." It
  requires host-authored receipts for status, capabilities, initialized grants, and allow/deny/
  negative changeset decisions; it is not certification, registry membership, or a public standard
  claim.
- **Core adoption receipt** — the host-authored evidence bundle for Core adoption: policy digest,
  baseline, validAsOf, coverage, authority evidence, achieved assurance mode, transaction guarantee,
  initialized grant evidence, and retained-guardrail statement.
- **Optional profile** — any ASP profile outside Core v1.0, including inspect, edit, apply,
  deployment surfaces, manager daemon, server catalog, dogfood, ACE integration, and reference-engine
  parity. Optional profiles do not satisfy Core gates by themselves.

### Capability Families

- **inspect** — read-only code intelligence (impact, callers, flows, search). Earlier docs may call
  this `sense`.
- **check** — evaluates an immutable `SnapshotRef`/`Baseline` plus `ChangeSet` and emits an
  **Assessment** with status, diagnostics/evidence, coverage, `validAsOf`, provider metadata,
  timing, and cache metadata. Earlier docs may call this `judge`.
- **edit** — proposes an `EditPlan` bound to a host-issued snapshot. The provider writes nothing,
  returns no executable mutation contract, and leaves validation/apply decisions to the host. Earlier
  docs may call this `act`.
- **gate** — a named policy requirement at a call-site. A host decision may block because required
  checks are denied or indeterminate.

### Borrowed from LSP (same concept, occasionally renamed)

- **Capabilities / capability negotiation** — at `initialize`, host and server each declare what
  they support; a verb is live only if both advertise it. Gives graceful degradation across vendors.
- **Diagnostic** — a finding: `severity`, `code`, `source`, `message`, `location`, `fingerprint`,
  `introduced`, and optional `help` / `codeDescription` / `fix`.
- **Push vs pull diagnostics** — push = background/watch diagnostics a server volunteers; pull = a
  synchronous provider assessment the host requests on a changeset before computing a gate decision.
- **Workspace edit** — a structured multi-file edit. The server *proposes* it; the host *applies* it.
- **Workspace** — repo-level scope (vs changeset- or file-level scope).

### Coined for ASP (no LSP equivalent)

- **v1.0 semantic object table** — the private semantic pack uses these canonical objects:

  | Object | Canonical meaning | v1.0 compatibility names |
  |---|---|---|
  | `SnapshotRef` | Host-issued immutable input identity for a tree plus optional dirty overlay. | `Baseline` and the `baseline` field are the current schema names for `SnapshotRef`. |
  | `ChangeSet` | Candidate delta over a `SnapshotRef`, expressed only as content-addressed blob transitions. | `changeset` remains the field name. |
  | `Assessment` | Provider-produced check output with status, diagnostics/evidence, requested/covered/degraded/unsupported coverage, exact `validAsOf`, provider metadata, timing, and cache metadata. It never carries host policy, authority grant, assurance, transaction, or decision fields. | Legacy `judge/evaluate` results are check assessments. |
  | `EditPlan` | Provider-produced mutation proposal bound to a base snapshot, with structured operations, touched-resource preconditions, completeness/refusal status, and exact `validAsOf`. | `WorkspaceEdit` is the reusable structured operation payload inside an edit plan; legacy `act/propose` projects the same proposal. |
  | `Decision` | Host-produced policy result: `allow`, `deny`, or `indeterminate`. | `verdict` is the transitional host envelope name. |
  | `Coverage` | Host-visible required, ran, and degraded provider/capability state, including typed provider lifecycle and capability health when degraded. | `coverage.enrolled` is transitional; it MUST equal `coverage.required` until #7 migrates names. |
  | `AssuranceMode` | Achieved enforcement mode: `advisory`, `gated`, `mediated-write`, or `isolated`. | Schema field: `assurance.mode`. |
  | `TransactionGuarantee` | Apply guarantee actually achieved: `none`, `rollback_attempted`, `text_only_transactional`, `workspace_transactional`, or `staged_snapshot`. | Schema field: `assurance.transactionGuarantee`. |
  | `BasePolicyAuthority` | Policy/config changes are evaluated under trusted base policy or a non-weakenable organization floor. | Candidate policy may be pending; it cannot authorize or weaken its own change. |

- **SnapshotRef** — the canonical semantic name for the host-stamped tree revision and optional dirty
  overlay a request is evaluated against. It is content-addressed and is the freshness anchor.
- **Baseline** — the v1.0 schema and field alias for `SnapshotRef`.
- **ChangeSet** — a proposed delta over a `SnapshotRef`/`Baseline`, expressed as content-addressed blob
  transitions. Inline bytes are never the authoritative candidate input.
- **Fail-class** — the control-plane classification of a failure: `health | contract | policy |
  input`. Drives fail-open vs fail-closed. Distinct from `severity`, which is presentational.
- **Assessment** — a server-produced check evaluation of a snapshot/changeset. It contains status
  (`complete | incomplete | unsupported | error | cancelled`), diagnostics/evidence, requested and
  covered scope/source/rule coverage, degraded or unsupported parts, exact `validAsOf` baseline plus
  changeset digest plus blob hashes read, provider id/version/config digest/capability version,
  timing, and cache metadata. It is not a policy decision, authority grant, assurance claim, or
  transaction guarantee. SARIF is an export/mapping target only, not the native ASP Assessment.
- **EditPlan** — a server-produced mutation proposal bound to a base snapshot. It contains provider
  metadata, status (`complete | incomplete | unsupported | error | cancelled`), exact `validAsOf`,
  touched resources, structured operations, preconditions, annotations, and explicit incomplete/
  refusal/unsupported/error data. It is not a command, host decision, authority grant, apply receipt,
  assurance claim, transaction guarantee, or direct write authority.
- **Decision** — a host-produced policy result: `allow | deny | indeterminate`, plus coverage,
  contributing assessments, policy digest, authority information, degraded coverage, achieved
  assurance mode, and any transaction guarantee.
- **Verdict object** — the transitional host-produced decision envelope carried to harnesses/users.
  It must remain host-produced; servers never return verdicts.
- **Audit receipt** — a host-authored record for status, evaluation, apply, or authority responses. It
  preserves provider provenance, policy digest, baseline/`validAsOf`, coverage, authority evidence,
  achieved assurance mode, and transaction guarantee.
- **Coverage** — host-visible required, ran, and degraded provider/capability state. Required coverage
  names must appear in `coverage.ran[]` or `coverage.degraded[]`; blocking diagnostics, missing,
  stale, incomplete, unsupported, malformed, cancelled, timed out, crashed, unavailable,
  quarantined, incompatible/skewed, or fail-open required coverage cannot silently pass a gate.
- **Degraded coverage** — visible coverage loss, reduced confidence, or non-allow Core gate evidence
  for a provider/capability: blocking diagnostic, missing, stale, incomplete, unsupported, malformed,
  cancelled, timed out, crashed, unavailable, quarantined, incompatible/skewed, fail-open,
  optional-only, missing authority, or lower-than-required assurance. Host degradation entries may
  carry `capability` and `providerState` so optional and required failures remain machine-routable.
- **Authority evidence** — independent evidence about a provider: identity, integrity, conformance,
  isolation, and authority. The older labels `first-party | certified | untrusted` are shorthand only
  and never grant blocking authority by themselves.
- **Provenance** — the authenticated identity of the server that produced a diagnostic. The host
  stamps it; a server cannot forge it.
- **validAsOf** — the baseline rev plus blob hashes a response is valid for. Lets the host detect
  staleness by hash equality, not mtimes.
- **Arbitration** — host resolution when multiple providers with the same capability overlap or
  disagree (dedup by fingerprint, precedence by authority grant).
- **Authority grant** — trusted policy saying a pinned provider identity/version/digest may satisfy a
  named gate requirement at a call-site. Certification, first-party provenance, and local
  installation do not imply authority.
- **Provider pin** — repository or organization policy input naming a provider id plus identity,
  integrity, conformance, isolation, and named authority requirements. It does not choose a host or
  launch a provider by itself.
- **Assurance mode** — the actual enforcement level achieved: `advisory`, `gated`,
  `mediated-write`, or `isolated`. Hosts must not claim `mediated-write` or `isolated` unless the
  deployment can prevent direct provider writes.
- **Graph envelope** — the normalized `nodes`/`edges` result shape every inspect verb, including
  retained legacy sense verbs, returns so the host consumes one shape regardless of a server's
  internal model.
- **Operation** — a named edit mutation a server proposes (`rename`, `move`, `change-signature`, …).
- **Apply intent** — an authorized harness, user, or agent request to `host/applyProposal`. It is
  sufficient protocol-level authorization for the host to attempt a write transaction; servers still
  cannot write autonomously. Server-initiated `applyEdit` is historical and superseded by ADR 0024.
- **Edit proposal precondition** — the expected resource state carried by create/update/delete/
  rename/text-edit operations. Existing resources carry an expected blob digest; creates carry
  expected absence. A mismatch is stale/conflict data for the host, not permission to overwrite.
- **Transaction guarantee** — the apply guarantee actually achieved, such as `none`,
  `rollback_attempted`, `text_only_transactional`, `workspace_transactional`, or `staged_snapshot`.
- **Capability profile** — a named bundle of required capabilities for a server or implementation
  track. A multi-capability server such as Opcore may satisfy an `inspect`/`check`/`edit` profile,
  but the conforming host still owns policy, authority, decisions, assurance mode, and transaction
  guarantee.

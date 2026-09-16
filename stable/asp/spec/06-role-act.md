---
title: "Role: act"
status: draft
normative: false
summary: Historical act role text retained as edit compatibility guidance. Servers propose; hosts stage/apply.
updated: 2026-06-22
---

# Role: act

> **2026-06-22 correction:** `act` is legacy/product shorthand. The normative capability family is
> `edit`. Edit-capable servers return edit plans. The host reports the actual assurance mode and
> transaction guarantee; direct-write prevention requires an enforceable sandbox, read-only snapshot,
> content API, or equivalent deployment mechanism.

## Historical role contract

An act server performs **reference-aware mutation** — rename, move, change-signature, multi-file
edit, organize-imports. It **proposes**; it never writes. The host validates the proposal (re-runs
gating checks) and applies or stages it according to the achieved transaction guarantee. Reference
impl: `cix`.

The propose/host-applies inversion is the core safety property: third-party mutation never touches
disk, and "validate before apply" is structural, not a convention. See
[ADR 0004](../decisions/0004-host-owns-verdict-and-fail-policy.md).

## Legacy capability alias (optional compatibility metadata)

Current provider declarations use canonical `edit` capability-family vocabulary. The historical wire
examples below show the retained `act` compatibility shape for early fixtures and adapters.

```jsonc
"capabilities": {
  "act": {
    "operations": ["rename","move","change-signature","multi-edit","organize-imports"],
    "scopes": ["workspace"]
  }
}
```

## Canonical `edit/propose` and legacy `act/propose`

The host asks the server to compute an `EditPlan` for an operation. Canonical bindings expose
`edit/propose`; `act/propose` is a compatibility shim for older adapters. Both return provider
proposal data only. The server writes nothing, and its response is neither a host decision nor an
apply receipt.

```jsonc
// host → server
{ "id":11, "method":"edit/propose", "params":{
    "operation":"rename",
    "args":{ "symbol":{ "id":"src/api.ts::Api.fetch" }, "newName":"request" },
    "baseline":{ "rev":"git:tree:9f3a1c", "stampedAt":"2026-06-16T10:00:00Z" },
    "scope":{ "paths":["src/api.ts","src/server.ts"] },
    "proposalId":"proposal:rename-api-fetch" } }

// server → host
{ "id":11, "result":{
    "proposal":{ "proposalId":"proposal:rename-api-fetch",
      "provider":{ "id":"lattice", "version":"0.1.0", "capabilityFamily":"edit",
                   "capabilityVersion":"edit/1.0", "configDigest":"sha256:editcfg" },
      "status":"complete",
      "baseline":{ "rev":"git:tree:9f3a1c" },
      "validAsOf":{ "baseline":{ "rev":"git:tree:9f3a1c" },
                    "blobs":["blob:sha256:aa01","blob:sha256:f1"] },
      "touchedResources":[ { "path":"src/api.ts", "kind":"modify",
        "precondition":{ "expectedDigest":"blob:sha256:aa01" } } ],
      "workspaceEdit":{ /* see below */ } } } }
```

`status:"incomplete"` means the server could not fully represent the operation (for example, a rename
whose references it could not all resolve). For a provider without authority or sufficient assurance,
the host MUST reject an incomplete proposal rather than apply a partial mutation. Incomplete,
unsupported, cancelled, or errored proposals carry explicit data so the host can render the refusal
or re-propose under bounded policy. Legacy `complete:false` and `incompleteReason` are compatibility
projections only.

## EditPlan / WorkspaceEdit

An `EditPlan` is a provider-produced mutation proposal. In v1.0 it carries a transitional
`WorkspaceEdit` payload anchored to the baseline it was computed against (optimistic concurrency).
Each file change is either granular text edits or a whole-blob replacement. The plan is a proposal with
preconditions, not apply authority.

```jsonc
{ "baseline":{ "rev":"git:tree:9f3a1c", … },
  "documentChanges":[
    { "path":"src/api.ts", "kind":"modify",
      "precondition":{ "expectedDigest":"blob:sha256:aa01" },
      "edits":[ { "range":{ "start":{"line":12,"char":13}, "end":{"line":12,"char":18} },
                 "rangeBasis":"blob:sha256:aa01", "coordinateSystem":"utf16",
                 "newText":"request" } ] },
    { "path":"src/server.ts", "kind":"modify",
      "precondition":{ "expectedDigest":"blob:sha256:f201" },
      "after":"blob:sha256:9c" },   // whole-blob replace
    { "path":"src/legacy.ts", "kind":"delete",
      "precondition":{ "expectedDigest":"blob:sha256:d001" } },
    { "path":"src/b.ts", "kind":"rename", "to":"src/c.ts",
      "precondition":{ "expectedDigest":"blob:sha256:e001" } },
    { "path":"src/new.ts", "kind":"create", "after":"blob:sha256:cc",
      "precondition":{ "expectedAbsence":true } } ] }
```

- `edits` (granular `TextEdit[]`) are for surgical changes and clean 3-way merges; `after` (a blob
  hash) is for whole-file replacement. A server MAY use either per file; the host normalizes the edit
  to an after-state changeset for validation. A whole-blob `after` that names a blob the server newly
  computed (not present in the baseline) MUST first be uploaded via the `workspace/putBlob` callback;
  the host adds proposal blobs to the transaction's referenced set so it can resolve them.
- The `baseline` field is the optimistic-concurrency anchor. If the host's current baseline differs in
  any touched path, the edit is stale (see conflicts).
- Every existing-resource operation MUST carry the expected prior blob digest. Every create MUST carry
  expected absence. A host MUST refuse a mismatch as stale/conflict/precondition data unless a bounded
  re-proposal or clean 3-way merge explicitly resolves it.
- A proposal MUST NOT contain shell commands, arbitrary scripts, command arrays, patch shellouts, or
  provider-owned apply instructions as the mutation contract. Such output is malformed provider data.
- A proposal MUST NOT contain host-owned result fields such as decisions, verdict envelopes, gating
  dispositions, authority grants, achieved assurance modes, or transaction guarantees.

## The apply transaction (host-executed)

Act proposes; the host applies. Application is a transaction, specified in
[host obligations §6](./07-host-obligations.md):

```
1. edit/propose or legacy act/propose -> EditPlan/WorkspaceEdit (vs baseline B)
2. host normalizes to hypothetical changeset = B ⊕ workspaceEdit
3. host runs gating checks on the hypothetical
4. allow -> apply/stage according to the host-reported transaction guarantee; issue new baseline B'
   deny/indeterminate -> reject; return the blocking diagnostics; nothing intentional is written
5. if B moved in a touched path while proposing → conflict handling (below)
```

The write is host-executed or staged; serialization, authorization, and conflict handling are
specified in [host obligations §6](./07-host-obligations.md#6-mediated-apply). Server code
never touches disk; a provider proposal MUST pass validation before applying.

## Conflict handling

- **Dirty target.** If `workspaceEdit.baseline` differs from the host's current baseline in any
  touched path, the proposal is stale.
- **3-way merge.** The host MAY attempt a 3-way merge (base = edit.baseline, ours = current, theirs =
  edit). On a clean merge it proceeds; otherwise it rejects.
- **Re-propose.** On rejection the host MAY re-issue the current baseline and call `act/propose` again,
  up to a bounded retry count (host policy; default 2), then reject for the caller to resolve.
  Re-proposals carry the same host-issued `proposalId` so retries dedup (on `(server, proposalId)`),
  and apply is serialized per workspace
  ([ADR 0013](../decisions/0013-serialized-apply-with-idempotency.md),
  [ADR 0024](../decisions/0024-supersede-server-initiated-apply-edit.md)).
- **No force.** The host MUST NOT overwrite conflicting local changes. Untrusted proposals that do not
  apply cleanly are rejected.

## No server-owned apply surface

A server MUST NOT request workspace application outside a host-issued edit-plan flow. Ambient watch
results MAY point to an available edit operation, but they are not write intent. The only conforming
write path is explicit user, agent, or harness authorization through the host-owned
`host/applyProposal` surface, followed by the host validation and apply/stage transaction
([ADR 0012](../decisions/0012-fix-application-user-initiated.md),
[ADR 0019](../decisions/0019-apply-intent-authorizes-host-writes.md),
[ADR 0024](../decisions/0024-supersede-server-initiated-apply-edit.md)).

The host MUST reject `workspace/putBlob` from a server lacking the canonical `edit` capability,
equivalent legacy `act` compatibility metadata, or a write grant (`scope_denied`). Uploaded blobs
only join the referenced set for a proposal transaction; they never grant filesystem authority or
apply authority.

## Historical compatibility checklist

A conformant edit provider that retains the legacy act surface:

- MUST NOT write to the workspace; it returns a `workspaceEdit` and lets the host apply.
- MUST compute the edit against the request `baseline` and echo that baseline in the `workspaceEdit`.
- MUST set `complete:false` when it cannot fully represent the operation (e.g. unresolved references).
- MUST produce an edit that applies cleanly to its stated baseline.
- MUST be reference-aware: a `rename`/`change-signature` MUST update all call sites or report
  `complete:false`.
- MUST carry `validAsOf`.
- MUST include per-resource preconditions and digest-bound text edit ranges.
- SHOULD support every operation it advertises in canonical `capabilities.edit.operations`; any legacy
  act operation list is compatibility metadata only.
- MAY use granular `edits` or whole-blob `after` per file.

See the schema in [`schemas/workspace-edit.schema.json`](../schemas/workspace-edit.schema.json) and
fixtures in [`examples/act/`](../examples/act/).

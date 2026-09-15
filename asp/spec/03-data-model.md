---
title: Data model
status: established
normative: true
summary: SnapshotRef/Baseline, content-addressed ChangeSet and blob protocol, Assessment, EditPlan, Diagnostic, and FailClass.
updated: 2026-06-23
---

# Data model

## SnapshotRef / Baseline

`SnapshotRef` is the canonical semantic object for immutable input identity. It is the host-stamped
tree revision plus optional dirty-overlay digest a request is evaluated against. The v1.0 schema and
field name is `Baseline`/`baseline`; the terms name the same freshness anchor until #7 completes the
schema migration.

```jsonc
{ "rev":"git:tree:9f3a1c", "dirty":"sha256:of-uncommitted-bytes", "stampedAt":"2026-06-16T10:00:00Z" }
```

`rev` is a content-addressed tree hash (e.g. a git tree). `dirty` digests any uncommitted overlay so
two working trees at the same commit but different dirty state get different snapshot refs. The host
is the sole issuer of `SnapshotRef`/`Baseline` values.

## v1.0 semantic objects

| Object | Producer | Consumer | Required binding |
|---|---|---|---|
| `SnapshotRef` / `Baseline` | host | providers and harness | Immutable tree/overlay identity; host-issued only. |
| `ChangeSet` | candidate/harness | host, then providers | Blob transitions over the snapshot; no inline authoritative bytes. |
| `Assessment` | check provider | host | Status, diagnostics/evidence, requested/covered/degraded/unsupported coverage, exact `validAsOf`, provider metadata, timing, and cache state. |
| `EditPlan` | edit provider | host | Provider proposal status, structured operations, touched-resource preconditions, exact `validAsOf`; no write authority or host result fields. |
| `Decision` | host | harness/user | `allow`, `deny`, or `indeterminate` plus coverage, authority, policy digest, assurance, receipt. |
| `Coverage` | provider and host | host and harness | Host decision coverage uses `required`, `ran`, and `degraded`; `enrolled` is transitional. |
| `AssuranceMode` | host | harness/user | Achieved `advisory`, `gated`, `mediated-write`, or `isolated` enforcement. |
| `TransactionGuarantee` | host | harness/user | Apply guarantee actually achieved; never stronger than the host can enforce. |
| `BasePolicyAuthority` | trusted policy source | host | Policy-changing candidates are evaluated under base policy or a non-weakenable organization floor. |

The [Core Profile](./11-core-profile.md) uses the tiny first subset of this table:
`SnapshotRef`/`Baseline`, immutable `ChangeSet`, provider `Assessment`, host `Decision`, and
decision `coverage.required`/`ran`/`degraded`. `EditPlan`, apply evidence, deployment surfaces,
dogfood, ACE integration, and reference-engine parity remain optional non-Core profiles.

## ChangeSet (content-addressed)

A proposed delta over a `SnapshotRef`/`Baseline`, expressed as blob-hash transitions. Inline bytes are
never the authoritative candidate input. The baseline `rev` plus the changeset is the after-state
identity.

```jsonc
{ "baseline": { "rev":"git:tree:9f3a1c", "stampedAt":"2026-06-16T10:00:00Z" },
  "changes": [
    { "path":"src/api.ts", "kind":"modify", "before":"blob:sha256:aa", "after":"blob:sha256:bb" },
    { "path":"src/new.ts", "kind":"create", "after":"blob:sha256:cc" },
    { "path":"src/old.ts", "kind":"delete", "before":"blob:sha256:dd" },
    { "path":"src/a.ts",  "kind":"rename", "from":"src/b.ts", "before":"blob:sha256:ee", "after":"blob:sha256:ee" } ] }
```

A server composes the **after-state** as `baseline + changes` (a path -> blob overlay).

## Blob protocol

Bytes are pulled lazily by content hash through two host callbacks. A blob id is the hash of its
content, so blobs are immutable and cacheable forever.

```jsonc
// server → host : enumerate baseline entries (scope-filtered)
{ "id":20, "method":"workspace/listTree", "params":{ "globs":["src/**/*.ts"] } }
//        ← { "entries":[ { "path":"src/api.ts", "blobId":"blob:sha256:aa", "kind":"file" }, … ] }

// server → host : fetch bytes, batched
{ "id":21, "method":"workspace/readBlob", "params":{ "blobs":["blob:sha256:bb","blob:sha256:cc"] } }
//        ← { "blobs":[ { "id":"blob:sha256:bb", "encoding":"utf-8",  "bytes":"…" },
//                      { "id":"blob:sha256:cc", "encoding":"base64", "bytes":"…" } ] }
```

This buys three properties (see [decision 0005](../decisions/0005-content-addressed-changesets.md)):

- **Cache by construction.** A blob id *is* its content hash. A warm server caches blobs across calls
  and sessions and re-fetches only unseen ids. Immutable inputs make caching trivially correct.
- **Least-privilege reads are enforced at the byte boundary.** `readBlob` is the permission
  chokepoint. The host MUST serve a blob only if it appears in the session's referenced set
  (baseline ∪ changeset) **and** its path is within the granted read globs — both, as a hard check.
  An in-scope path whose hash is *not* in the referenced set MUST be refused (a `policy` error). Read
  scope is evaluated against the **granted globs**, never against changeset-declared paths, so a
  crafted changeset cannot widen what a server may read. `listTree` is filtered to the same granted
  globs and MAY be result-capped (an out-of-scope path yields nothing, so a server cannot probe tree shape outside its grant); servers MUST tolerate a refusal or truncation. A scanner that pulls
  only `after` blobs of changed files *cannot* read the rest of the tree — sandbox by protocol.
- **`validAsOf` is exact.** The baseline rev plus the set of blob hashes read is the freshness
  identity the server echoes; the host detects staleness by hash equality, never mtimes.

## Assessment

A check provider returns an `Assessment` with the canonical fields defined in
[`schemas/check-assessment.schema.json`](../schemas/check-assessment.schema.json): `status`,
`diagnostics`, optional structured `evidence`, `coverage`, `validAsOf`, `provider`, `timing`, and
`cache`. Status is one of `complete | incomplete | unsupported | error | cancelled`.
`unsupported` means the provider cannot cover the requested language, scope, comparison, source, rule
set, or capability version; `error` means it attempted evaluation and failed for a provider/runtime
reason represented as assessment data.

`coverage` records requested scope/source/rule coverage, covered coverage, degraded parts,
unsupported parts, and whether evaluation was exhaustive or truncated. A complete assessment is still
not a host decision. Missing, stale, incomplete, unsupported, malformed, cancelled, timed-out,
quarantined, skewed, fail-open, or errored required coverage remains visible for host policy and
cannot contribute to `allow`.

`validAsOf.baseline` MUST equal the host-issued `SnapshotRef`/`Baseline` for the request.
`validAsOf.changesetDigest` MUST equal the immutable changeset digest the host requested.
`validAsOf.blobs` MUST list every blob read so the host can reject, downgrade, or reissue stale
assessments by exact equality over baseline, changeset digest, and blob set.

`provider` carries id, version, config digest, capability version, and optional build/artifact digest.
These are evidence inputs only. They do not grant authority. `timing` supports elapsed time or
start/end timestamps for budgets and metrics. `cache` reports hit, miss, stale, or disabled state with
cache identity when available. SARIF is a future export or mapping target; native ASP assessments are
diagnostics/evidence plus ASP freshness, coverage, provider, timing, and cache metadata.

Provider-owned structured data inside an assessment, including `evidence[].data` and diagnostic
`fix.args`, is still provider assessment payload. It MUST reject host-owned result field names at any
depth; fix arguments may parameterize a later edit proposal but cannot carry gate authority,
assurance, or transaction claims.

## EditPlan

An edit provider returns an `EditPlan`, defined by
[`schemas/edit-plan.schema.json`](../schemas/edit-plan.schema.json). It is provider proposal data
only:

- `proposalId`, provider metadata, and `status` using the shared
  `complete | incomplete | unsupported | error | cancelled` vocabulary;
- `baseline` and `validAsOf.baseline` bound to the host-issued `SnapshotRef`/`Baseline`;
- `validAsOf.blobs` listing every blob read while preparing the proposal;
- `touchedResources[]` and `workspaceEdit.documentChanges[]` with per-resource preconditions;
- `workspaceEdit` structured operations for create, modify, delete, rename/move, whole-blob
  replacement, and digest-bound granular text edits;
- optional annotations, confidence, rationale, warnings, and explicit incomplete/unsupported/refusal/
  error/conflict data.

Existing-resource operations carry `precondition.expectedDigest`. Create operations carry
`precondition.expectedAbsence:true`. Granular text edits carry a `rangeBasis` digest and
`coordinateSystem:"utf16"` so ranges cannot silently apply to changed content. Whole-resource content
introduced by the proposal is represented by host-managed blob refs, normally returned from
`workspace/putBlob`.

An `EditPlan` is not executable instructions. Provider output containing shell commands, arbitrary
scripts, command arrays, host decisions, verdict envelopes, authority grants, achieved assurance
modes, or transaction guarantees is malformed or non-authoritative. The host normalizes the plan into
a hypothetical `ChangeSet`, validates freshness, scope, preconditions, blobs, conflicts, authority,
and required check coverage, then reports any apply receipt and achieved transaction guarantee.

## Diagnostic

A finding. The same shape serves check-provider assessments and inspect advisories; the host decides
whether any finding is gating.

```jsonc
{ "code":"acme-secrets/aws-key",
  "severity":"error",          // effective severity inside an enrolled gate (gating = enrollment, ADR 0008)
  "source":"acme-secrets",     // host OVERWRITES with the authenticated server id (provenance)
  "message":"hardcoded AWS key",
  "help":"Load the key from an env var at runtime.", // optional next-step surfaced to the user
  "location":{ "path":"src/api.ts", "range":{ "start":{"line":41,"char":2}, "end":{"line":41,"char":40} } },
  "fingerprint":"sha256:7c…",  // stable, position-resilient identity for before/after diffing
  "introduced":true,           // set when comparison = introduced
  "fix":{ "editRef":"acme-secrets/redact", "args":{ … } } }  // optional ref to an edit proposal
```

**`fingerprint` MUST be position-resilient** — a hash of rule + normalized message + a position-resilient
semantic key (e.g. the enclosing symbol id), *not* the raw line number. Otherwise inserting code above a pre-existing violation makes it look
newly introduced. A fingerprint is authoritative only *within* its `diagnosticSource`;
the host canonicalizes for any cross-server grouping, and cross-server equality never affects a gate
([ADR 0010](../decisions/0010-fingerprints-per-source-host-canonicalizes.md)).

## FailClass

The control-plane classification of a *failure to evaluate* (not of a finding). It drives the host's
fail-open vs fail-closed decision; see [host obligations](./07-host-obligations.md).

| failClass | Meaning | Typical host treatment |
|---|---|---|
| `health` | The server could not run (cold index, OOM, timeout) | Fail **open** on interactive edits, **closed** on gates |
| `contract` | The server ran but violated the protocol (bad shape, version skew) | Fail **closed** always — fix the server |
| `policy` | A policy/config error in the request | Fail closed |
| `input` | Malformed changeset/params | Fail closed |

`severity` and `failClass` are orthogonal: `severity` says how bad a *finding* is; `failClass` says
why an *evaluation* failed.

## Workspace edit

A transitional payload name for the structured operations inside an `EditPlan`. Edits are
content-addressed like changesets. The server proposes; the **host** applies or stages it and reports
the achieved transaction guarantee — the server never writes. Full shape is specified in the historical
[act/edit compatibility chapter](./06-role-act.md).

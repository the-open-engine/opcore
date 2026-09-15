---
title: Transport and lifecycle
status: draft
normative: true
summary: Private JSON-RPC stdio dogfood floor, optional warm transports, the initialize handshake, and the session state machine.
updated: 2026-06-23
---

# Transport and lifecycle

> **2026-06-23 binding decision:** [ADR 0025](../decisions/0025-asp-binding-bakeoff.md)
> chooses native JSON-RPC over stdio as the private dogfood binding floor. A namespaced MCP
> extension remains a private compatibility/status experiment; the semantic contract remains
> transport-neutral.

## Transport

This chapter records the private **JSON-RPC 2.0** dogfood floor, newline-delimited (one JSON object
per line, no embedded newlines). It is not a public deployment commitment, stable package surface, or
deployment trust root.

- **stdio** is the floor for private dogfood. Every server using this binding MUST speak JSON-RPC
  over stdin/stdout when spawned by the host. This is the simplest path for plug-in authors and
  matches MCP/LSP host models.
- **Unix domain socket** is an advertised capability for persistent, warm, shared servers (the
  current `rox`/`cix` model). A server MAY advertise `transport: ["stdio","socket"]`; the host
  chooses only when socket behavior preserves stdio semantics.

Requests carry an `id` and expect a response. Notifications omit `id` and MUST NOT be answered.
`$/`-prefixed methods are protocol utilities (progress, cancellation). See
[decision 0001](../decisions/0001-base-on-json-rpc-2.0.md).

## Session model

One **stateful session per workspace root**. The server holds its model warm across calls — that
warmth is the reason these are servers, not CLI shells. The host owns session lifecycle: it spawns,
initializes, supervises, and shuts down the server.

## State machine

```
spawned ──initialize──▶ initializing ──initialized──▶ active ──shutdown──▶ shuttingDown ──exit──▶ exited
```

- Before `initialize` succeeds, the server MUST NOT perform work and the host MUST NOT send
  capability requests.
- In `active`, capability requests flow, including retained compatibility method names
  (`sense/*`, `judge/*`, `act/*`) mapped to canonical `inspect`, `check`, and `edit`, plus host
  callbacks. These aliases do not change the semantic rule that providers return assessments or edit
  plans while hosts return decisions.
- `shutdown` (request) tells the server to stop accepting work and flush; `exit` (notification) ends
  the process.

The [Core Profile](./11-core-profile.md) uses only the tiny first host/provider/check path in this
state machine: `initialize`, the host's `initialized` grant, `workspace/readBlob`,
`workspace/listTree`, and `check/evaluate` behind `host/evaluateChangeset`. Inspect, edit, apply,
deployment surfaces, dogfood, ACE integration, and reference-engine parity remain non-Core.

## The initialize handshake

Capability negotiation, permission capping, and `SnapshotRef`/`Baseline` issuance happen here. Note
that the host **narrows** what the server requested.

```jsonc
// host → server
{ "jsonrpc":"2.0", "id":1, "method":"initialize", "params":{
  "protocolVersion":"asp/1.0",
  "host":{ "name":"covibes-host", "version":"0.1.0" },
  "hostCapabilities":{ "progress":true, "pullDiagnostics":true, "readBlob":true, "putBlob":true },
  "workspace":{ "root":"/repo",
    "baseline":{ "rev":"git:tree:9f3a1c", "dirty":"sha256:ab…", "stampedAt":"2026-06-16T10:00:00Z" } },
  "assuranceMode":"advisory" } }

// server → host
{ "jsonrpc":"2.0", "id":1, "result":{
  "serverInfo":{ "name":"acme-secrets", "version":"1.2.0", "fingerprint":"sha256:dd…" },
  "capabilityFamilies":["check"],
  "roles":["judge"], // legacy compatibility metadata
  "capabilities":{
    "check":{ "diagnosticSources":["acme-secrets"], "scopes":["changeset","workspace"],
              "comparisons":["introduced","all"], "fixes":true },
    "watch":{ "push":true } },
  "requestedPermissions":{ "read":["**/*"], "write":false, "network":true },
  "provenance":{ "publisher":"acme", "signature":"…" } } }

// host → server  (notification) — read narrowed, network denied
{ "jsonrpc":"2.0", "method":"initialized", "params":{
  "grantedPermissions":{ "read":["src/**","!**/.env*"], "write":false, "network":false,
                         "resourceLimits":{ "cpuPct":50, "memoryMb":512, "wallclockMs":30000, "fd":256 } },
  "baseline":{ "rev":"git:tree:9f3a1c", "dirty":"sha256:ab…", "stampedAt":"2026-06-16T10:00:00Z" } } }
```

Rules:

- The host MUST reject (`initialize` error, `failClass: contract`) a server whose `protocolVersion`
  it cannot satisfy. There is no silent degradation — negotiate or refuse.
- The server MUST treat `grantedPermissions` as authoritative and operate within it; the host
  enforces the grant regardless.
- The host builds a mandatory sandbox from the grant (`resourceLimits` + egress-deny + isolation —
  [ADR 0009](../decisions/0009-mandatory-minimal-sandbox.md)); the server runs as an isolated process
  and MUST tolerate resource caps and `readBlob` refusals.
- The `fingerprint` is a content hash of the server build. A changed build MUST produce a changed
  fingerprint so the host can detect version skew.

## Protocol utilities

| Method | Direction | Purpose |
|---|---|---|
| `$/progress` | server → host | Stream progress / partial results for long operations |
| `$/cancelRequest` | host → server | Cancel an in-flight request by `id` |
| `workspace/baselineChanged` | host → server | Advance the session baseline when the tree moves |
| `shutdown` / `exit` | host → server | End the session |

## Host callbacks (server → host requests)

These let a server pull or upload content-addressed blobs without filesystem access. The host
scope-checks every one. They are not write intent; applying a proposal is owned by the harness-facing
`host/applyProposal` surface after explicit user, agent, or harness authorization.
Server-initiated `applyEdit` is historical and non-conforming; the write path is superseded by
[ADR 0024](../decisions/0024-supersede-server-initiated-apply-edit.md).

| Method | Purpose |
|---|---|
| `workspace/listTree` | Enumerate baseline entries (path → blobId), scope-filtered |
| `workspace/readBlob` | Fetch blob bytes by content hash (batched) |
| `workspace/putBlob` | Upload bytes for a proposal-introduced blob; host adds it to the referenced set (edit/legacy act) |
| `window/logMessage` | Diagnostics / telemetry to the host |

See [data model](./03-data-model.md) for the content-addressed blob protocol and
[host obligations](./07-host-obligations.md) for how callbacks are policed.

## Errors

A failure-to-evaluate uses the JSON-RPC error object
([`schemas/error.schema.json`](../schemas/error.schema.json)). `error.data.failClass`
(`health | contract | policy | input`) is **authoritative** — the host keys fail-policy off it.
`error.code` is advisory. A deny or indeterminate host decision is never an error; it is a successful
result carrying diagnostics and coverage evidence. A provider assessment with findings is also never
an error; it is a successful result carrying diagnostics, status, and coverage.

ASP reserves the JSON-RPC server-error range `-32099..-32000`. Registry:

| code | name | failClass |
|---|---|---|
| -32010 | `health_not_ready` | health |
| -32011 | `stale_baseline` | health (retryable) |
| -32012 | `scope_denied` | policy |
| -32013 | `invalid_changeset` | input |
| -32014 | `unsupported_version` | contract |
| -32015 | `blob_unavailable` | health |
| -32016 | `cancelled` | health (retryable) |

## Streaming and cancellation

A server that advertised `partialResults` MAY stream `$/progress` notifications
([`schemas/progress.schema.json`](../schemas/progress.schema.json)) before the terminal result: each
carries an incremental `diagnostics` batch (`kind:"diagnostics"`), a `report`, or an `end` marker. The
final result on the original request `id` is authoritative and supersedes the streamed partials for
both the JSON-RPC stdio floor and any future binding adapter. Progress is advisory; it cannot allow a
gate or apply a proposal. On `$/cancelRequest`, the server SHOULD stop and return an error with
`failClass:"health"`, `retryable:true`, code `-32016`; the host still reports the terminal
cancelled/degraded coverage state for `gate` call-sites.

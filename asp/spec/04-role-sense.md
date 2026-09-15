---
title: "Role: sense"
status: draft
normative: false
summary: Historical sense role text retained as inspect compatibility guidance.
updated: 2026-06-22
---

# Role: sense

> **2026-06-22 correction:** `sense` is legacy/product shorthand. The normative capability family is
> `inspect`. This chapter is compatibility guidance for the initial inspect method vocabulary;
> conformance attaches to canonical `inspect` capability declarations, not to a server role named
> `sense`.

## Historical role contract

A legacy sense/inspect server provides **read-only** code intelligence over a `SnapshotRef`/`Baseline`.
It answers "what is true / what is connected." It is side-effect free and MUST NOT mutate. Reference
impl: `crg`.

Sense is not a gate. Its results inform the host and the agent; they never block. A sense server MAY
emit advisory [diagnostics](./03-data-model.md#diagnostic) (`severity` `info`/`warning`), but the host
treats sense diagnostics as advisory always.

## Legacy capability alias (optional compatibility metadata)

Current provider declarations use canonical `inspect` capability-family vocabulary. The historical
wire examples below show the retained `sense` compatibility shape for early fixtures and adapters.

```jsonc
"capabilities": {
  "sense": {
    "verbs": ["references","callers","callees","impact","symbols"], // typed core it answers
    "query": ["tested-by","inheritors","flows"],                    // tool-specific verbs via sense/query
    "scopes": ["changeset","workspace"],
    "graph": { "nodeKinds": ["file","class","function","type","test"],
               "edgeKinds": ["calls","imports","inherits","implements","contains","tested-by"] }
  }
}
```

## Graph envelope

All typed verbs return a normalized graph envelope, so the host consumes one shape regardless of the
server's internal model.

```jsonc
// Node
{ "id":"src/api.ts::Api.fetch",  // stable id (qualified name); the addressing key
  "kind":"function",             // file | class | function | type | test | module
  "name":"fetch",
  "location":{ "path":"src/api.ts", "range":{ "start":{"line":12,"char":2},"end":{"line":20,"char":3} } },
  "exported":true, "test":false }

// Edge
{ "kind":"calls",                // calls | imports | inherits | implements | contains | tested-by | depends-on
  "from":"src/api.ts::Api.fetch", "to":"src/http.ts::request",
  "location":{ "path":"src/api.ts", "range":{ … } } }

// SymbolRef — how the host addresses a symbol in a request
{ "path":"src/api.ts", "position":{ "line":12,"char":2 } }   // position form
// or
{ "id":"src/api.ts::Api.fetch" }                              // id form
```

## Legacy methods (typed core)

| Method | Params | Result |
|---|---|---|
| `sense/references` | `{ symbol: SymbolRef, scope }` | `{ nodes, edges, validAsOf }` |
| `sense/callers` | `{ symbol: SymbolRef, depth? }` | `{ nodes, edges, validAsOf }` |
| `sense/callees` | `{ symbol: SymbolRef, depth? }` | `{ nodes, edges, validAsOf }` |
| `sense/symbols` | `{ query: string, kinds? }` | `{ nodes, validAsOf }` |
| `sense/impact` | `{ changeset, depth?, scope }` | `{ changedNodes, impactedNodes, impactedFiles, edges, truncated, validAsOf }` |
| `sense/query` | `{ verb: string, args: object }` | `{ nodes?, edges?, data?, validAsOf }` |

Every typed request MAY include an optional `baseline` override; absent it, the current session
baseline applies.

### `sense/impact` — the integration point

`sense/impact` computes the blast radius of a changeset. It is how legacy sense and judge surfaces map
to canonical inspect and check **through the host**: the host asks inspect providers for impact, then
passes the resulting `impactedFiles` to check providers as `scope: { "paths": [...] }`. This is
over-inclusive by design (conservative recall), so a check provider sees everything the change could
affect, not just the edited files.

```jsonc
// host → server
{ "id":9, "method":"sense/impact", "params":{
    "changeset":{ /* content-addressed */ }, "depth":2, "scope":"workspace" } }
// server → host
{ "id":9, "result":{
    "changedNodes":[ … ], "impactedNodes":[ … ],
    "impactedFiles":["src/api.ts","src/http.ts","src/server.ts"],
    "edges":[ … ], "truncated":false,
    "validAsOf":{ "rev":"git:tree:9f3a1c", "blobs":["blob:sha256:bb02"] } } }
```

### `sense/query` — the escape hatch

For tool-specific intelligence that does not warrant a typed method (e.g. `tested-by`, `inheritors`,
`flows`, `communities`). Historically, the verb was advertised in `capabilities.sense.query`. Current
providers declare canonical `inspect` support first and may retain that field as compatibility
metadata. The result is the normalized envelope plus an optional verb-specific `data` object.

## Freshness — answer as-of the baseline

Sense verbs answer as-of the **current session baseline** (issued at `initialized`, advanced by the
host via a `workspace/baselineChanged` notification). A request MAY carry an optional `baseline` to ask
about a specific revision ([ADR 0014](../decisions/0014-sense-session-baseline-with-override.md)).

A sense server MAY maintain its own persistent index (like `crg`'s graph) rather than reading
everything per call. Either way it MUST answer relative to the **effective baseline** (session or
override):

- On success, `validAsOf.rev` MUST equal the effective baseline `rev`. If the server's index is behind,
  it MUST reconcile first — pulling changed blobs via `workspace/readBlob` and updating incrementally —
  before answering.
- If it cannot reach the requested baseline (e.g. mid-rebuild), it MUST return a `health` error rather
  than answer against a stale graph. Stale-but-silent is forbidden.

This is the freshness-as-correctness rule for stateful sense servers; see
[ADR 0007](../decisions/0007-sense-answers-as-of-baseline.md).

## Reads

Sense obtains content only via `workspace/listTree` + `workspace/readBlob`; the same least-privilege
blob guarantees as judge apply (see [data model](./03-data-model.md#blob-protocol)).

## Historical compatibility checklist

A conformant inspect provider that retains the legacy sense surface:

- MUST declare canonical `inspect` capability support; it MAY also expose a legacy `sense`
  compatibility object listing the typed `verbs` and any `query` verbs it answers.
- MUST answer relative to the effective baseline (session or override); on success `validAsOf.rev` MUST
  equal that baseline `rev`, else it MUST return a `health` error.
- MUST carry `validAsOf` on every result.
- MUST return the normalized graph envelope (`nodes`/`edges`) for typed verbs; `sense/query` MAY add a
  `data` object.
- MUST obtain content only via `workspace/readBlob`/`listTree`; MUST NOT assume filesystem access.
- MUST be side-effect free; MUST NOT mutate the workspace.
- SHOULD implement `sense/impact` (the judge-scoping integration point) and SHOULD honor
  `$/cancelRequest`.
- MAY expose tool-specific verbs via `sense/query`; MAY emit advisory diagnostics (never gating).

See the schema in [`schemas/sense-graph.schema.json`](../schemas/sense-graph.schema.json) and fixtures
in [`examples/sense/`](../examples/sense/).

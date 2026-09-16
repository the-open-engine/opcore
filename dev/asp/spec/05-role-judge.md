---
title: "Role: judge"
status: draft
normative: false
summary: Historical judge role text retained as check compatibility guidance. Servers return assessments; the host computes decisions.
updated: 2026-06-22
---

# Role: judge

> **2026-06-22 correction:** `judge` is legacy/product shorthand. The normative capability family is
> `check`. Check-capable servers return assessments and evidence, not verdicts or final gate
> decisions. The host computes `allow | deny | indeterminate`.

> **Core Profile:** [ASP v1.0 Core](./11-core-profile.md) uses this check path as the tiny first
> host/provider/check profile. Inspect, edit, apply, deployment surfaces, dogfood, ACE integration,
> and reference-engine parity remain non-Core.

## Historical role contract

A judge/check server evaluates a **changeset against a baseline** and returns an **assessment** containing
status, diagnostics, coverage, and freshness. It MUST NOT decide pass/fail — the host computes the
decision envelope ([host obligations](./07-host-obligations.md)) — and MUST NOT write, which is
[act/edit](./06-role-act.md)'s job. It is pure over content it pulls on demand.

## Legacy capability alias (optional compatibility metadata)

Current provider declarations use canonical `check` capability-family vocabulary. A retained `judge`
object, when present, is compatibility metadata aligned to the canonical check capability.

```jsonc
"capabilities": {
  "check": {
    "capabilityVersion": "check/1.0",
    "diagnosticSources": ["acme-secrets"],   // >=1; namespaces every diagnostic's code
    "scopes": ["changeset","workspace"],      // what it can evaluate
    "comparisons": ["introduced","all"],      // baseline-diff modes it supports
    "partialResults": true,                   // streams diagnostics via $/progress
    "incremental": true,                      // can reuse prior evaluation state
    "unsupportedReporting": "assessment-status",
    "fixes": true                             // compatibility hint: diagnostics may bridge to edit
  },
  "judge": { /* optional legacy alias with the same check fields */ },
  "watch": { "push": true }                   // optional ambient/background mode
}
```

## Canonical `check/evaluate` and legacy `judge/evaluate`

`check/evaluate` is the canonical provider assessment call. `judge/evaluate` is a compatibility shim
with the same request semantics and the same canonical Assessment success result. `scope` bounds what
is evaluated; `comparison` selects the baseline diff.

```jsonc
// host → server
{ "id":7, "method":"check/evaluate", "params":{
    "changeset": { /* content-addressed; see data-model */ },
    "scope": "changeset",                     // changeset | workspace | { "paths":[…] }
    "comparison": "introduced",               // introduced (default, gating) | all | resolved
    "diagnosticSources": ["acme-secrets"] } } // host MAY run a subset

// server → host  (assessment success)
{ "id":7, "result":{
    "status":"complete",
    "diagnostics":[
      { "code":"acme-secrets/aws-key", "severity":"error",
        "source":"acme-secrets", "message":"hardcoded AWS key",
        "location":{ "path":"src/api.ts", "range":{ "start":{"line":41,"char":2},"end":{"line":41,"char":40} } },
        "fingerprint":"sha256:7c…", "introduced":true,
        "fix":{ "actRef":"acme-secrets/redact", "args":{ … } } } ],
    "coverage":{
      "requested":{ "scope":"changeset", "diagnosticSources":["acme-secrets"], "rules":["acme-secrets/aws-key"], "comparison":"introduced" },
      "covered":{ "scope":"changeset", "diagnosticSources":["acme-secrets"], "rules":["acme-secrets/aws-key"], "comparison":"introduced" },
      "degraded":[], "unsupported":[], "exhaustive":true, "truncated":false },
    "validAsOf":{
      "baseline":{ "rev":"git:tree:9f3a1c" },
      "changesetDigest":"sha256:changeset-introduced-001",
      "blobs":["blob:sha256:aa01","blob:sha256:bb02","blob:sha256:cc03"] },
    "provider":{
      "id":"acme-secrets", "version":"1.2.0", "configDigest":"sha256:cfg",
      "capabilityVersion":"check/1.0", "capabilityFamily":"check" },
    "timing":{ "elapsedMs":914 },
    "cache":{ "status":"miss", "key":"sha256:cache-key" } } }

// compatibility method name, same params/result contract
{ "id":7, "method":"judge/evaluate", "params":{ /* same as check/evaluate */ } }
```

### Request configuration

The optional `configuration` object carries resolved provider-specific settings. Each provider MUST
document and strictly validate its configuration schema, rejecting unknown fields, invalid values,
and explicit `null` with `invalid-input` before evaluating source. Omission selects the provider's
documented defaults. The provider MUST apply the same effective settings to both comparison views;
it MUST NOT discover workflow names, override layers, or execution permissions from this object.

Every Assessment status MUST report `provider.configDigest` for the normalized effective settings.
Providers MUST document deterministic canonicalization, and hosts MUST verify the expected digest
before accepting the assessment. Equivalent omitted and explicit default settings have the same
identity. Timing, findings, and runtime outcomes MUST NOT enter this digest. Workspace callbacks bind
compiler/project configuration through `validAsOf.blobs`; evidence records external tool identities.
Configuration never widens the initialized read, write, network, or resource grant.

Opcore Zero Fast accepts `{ "verify": { ... } }` with the built-in Verify threshold fields. Its native
profiles accept only `{}` because their project settings arrive through workspace callbacks. Opcore
computes SHA-256 over compact UTF-8 JSON with recursively sorted object keys and no insignificant
whitespace: `{ "provider": <provider id>, "capabilityVersion": "check/1.0", "configuration": <effective settings> }`.
Fast includes every effective Verify field; native settings are `{}`. Hosts send only the settings
for the selected provider, after resolving repository and workflow overrides.

### Assessment statuses

- **`complete`** — requested evaluation completed for the declared coverage.
- **`incomplete`** — the provider ran but could not cover the full requested scope.
- **`unsupported`** — the provider does not support the requested language, scope, comparison,
  capability version, file kind, rule set, or diagnostic source.
- **`error`** — the provider attempted the evaluation but failed for a provider/runtime reason
  represented as assessment data.
- **`cancelled`** — evaluation was cancelled before completion.

`unsupported` is distinct from `error` so hosts can route capability gaps separately from provider
failures. Required `incomplete`, `unsupported`, `error`, or `cancelled` assessments are degraded host
coverage and cannot silently satisfy a gate.

Provider assessments MUST NOT contain host-owned fields such as pass/fail projections, decisions,
verdict envelopes, finding dispositions, authority grants, assurance modes, or transaction
guarantees. A provider output that includes those fields is malformed and host policy treats it as
degraded coverage.

The prohibition applies recursively to structured provider data such as `evidence[].data` and
diagnostic `fix.args`. These fields may carry evidence or edit-provider arguments, but they cannot
carry host-owned gate results, authority grants, assurance claims, or transaction guarantees.

### Comparison modes

- **`introduced`** (gating default) = `after \ before` by `fingerprint`. Only diagnostics this
  changeset adds. Requires evaluating both before- and after-state of affected files and diffing by
  fingerprint; a server MAY optimize but the *contract* is set-difference by fingerprint.
- **`all`** = every diagnostic in the after-state within scope. For full sweeps / CI.
- **`resolved`** = present in before, gone in after. For credit and metrics.

For a `create`d path the before-state is the empty document, so every finding in a new file is
`introduced`. For a `delete`d path the after-state is empty, so its before-findings are `resolved`.

### Negative assessment ≠ error

Finding violations returns a `result`. Only an *inability to evaluate* uses the JSON-RPC error
channel, and that error MUST carry a `failClass`:

```jsonc
{ "id":7, "error":{ "code":-32010, "message":"index not warm",
    "data":{ "failClass":"health", "retryable":true } } }
```

The host maps `failClass` × call-site to fail-open vs fail-closed
([host obligations](./07-host-obligations.md)).

### Incremental evaluation

`judge/evaluate` MAY include `priorDiagnostics` — the host-cached before-state findings for the
changeset's `before` blobs. A server that advertised `incremental` MAY use these as the before-set and
evaluate only the after-state, diffing by `fingerprint`; absent them (a cold call, or a non-incremental
server) it computes both states ([ADR 0011](../decisions/0011-host-supplies-before-state.md)).

## Watch (push) mode

Ambient diagnostics while the agent works — advertised via `watch.push`, never used for gating.
Schema: `host-callbacks.schema.json#/$defs/publishDiagnostics.params`; a new batch for a `uri`
supersedes the prior one.

```jsonc
// server → host (notification), against the live working baseline
{ "method":"judge/publishDiagnostics", "params":{
    "uri":"src/api.ts", "validAsOf":{ "rev":"git:working:…" }, "diagnostics":[ … ] } }
```

## Fixes — the check → edit bridge

A diagnostic MAY carry `fix`, which is *declared composition*: either an inline content-addressed
`workspaceEdit`, a canonical `editRef`, or an `actRef` naming a legacy act/edit capability plus args.
Either way the
**host** mediates it (validate -> apply/stage according to the achieved guarantee); the judge/check
provider never mutates. Application is user/agent-initiated; the host never auto-applies
([ADR 0012](../decisions/0012-fix-application-user-initiated.md)).

## Historical compatibility checklist

A conformant check provider that retains the legacy judge surface:

- MUST declare canonical `check` capability support with capability version, diagnostic sources,
  scopes, comparisons, partial-result support, incremental support, and unsupported-reporting
  semantics; it MAY also expose a legacy `judge` compatibility object with the same shape.
- MUST treat `before`/`after` as blob refs and obtain bytes only via `workspace/readBlob`; MUST NOT
  assume filesystem access.
- MUST echo `validAsOf` covering the baseline, changeset digest, and every blob it read.
- MUST emit stable, position-resilient `fingerprint`s.
- MUST return `introduced` diffs when it advertises that comparison.
- MUST surface an Assessment as a success `result`; legacy transport errors remain only for
  request/session inability-to-evaluate cases and every such error MUST carry a `failClass`.
- MUST keep SARIF as export/mapping only; native ASP check results are Assessments.
- MUST NOT write to the workspace or act outside granted permissions.
- SHOULD honor `$/cancelRequest`; SHOULD set `exhaustive:false` when it samples or truncates.
- SHOULD carry a `fix` or a `help` next-step on an `error`-severity diagnostic.
- If it advertises `incremental`, SHOULD consume `priorDiagnostics` and evaluate only the after-state.
- MAY provide `fix`es; MAY push `watch` diagnostics if it advertised `watch.push`.

See fixtures in [`examples/judge/`](../examples/judge/) and the schema in
[`schemas/judge-evaluate.schema.json`](../schemas/judge-evaluate.schema.json).

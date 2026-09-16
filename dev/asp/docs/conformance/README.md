---
title: Core conformance evidence
status: draft
normative: false
summary: Private Core host, check-provider server, interop, edit/apply host, assurance honesty, and hostile-provider matrix report scaffolds, commands, and report interpretation.
updated: 2026-06-26
---

# Core, Interop, Edit, Assurance, And Hostile Conformance Evidence

This directory defines the private conformance scaffolds. The host suite emits `CORE-*`
evidence by launching the real `asp host serve --repo <workspace>` JSON-RPC stdio host for host
status, capabilities, and evaluate behavior. Static fixtures remain examples and schema checks, not
the only proof for host Core requirements. The check-provider server suite emits `CORE-SERVER-*`
evidence by launching a candidate provider behind a fake host over the private JSON-RPC stdio
dogfood binding. The interop suite emits `INTEROP-*` evidence by running reference-host and
independent-host combinations against fake and ordinary enrolled provider entrypoints through the same
Core provider contract. The hostile-provider matrix emits `HOSTILE-*` evidence by driving the same
black-box host through the outer seam with hostile fake providers and edit providers. All reports
record behavior evidence without granting authority.
The edit/apply host profile emits `EDIT-HOST-*` evidence by driving `host/requestEditPlan` and
`host/applyProposal` through the same outer seam with canonical fake edit providers. The assurance
profile emits `ASSURANCE-*` evidence for honest assurance-mode and transaction-guarantee reporting on
the same apply path.

Host Core evidence is limited to:

- black-box `host/status`;
- black-box `host/capabilities`;
- black-box `host/evaluateChangeset`;
- provider `check/evaluate` Assessment shape;
- provider Assessment forbidden host-owned fields;
- stale, missing, malformed, unsupported, incomplete, cancelled, provider-error, timeout, stale
  baseline, fabricated-blob, stale-workspace-blob, missing-authority, insufficient-assurance,
  quarantined, skewed, initialize/version contract refusal, fail-open, and degraded required
  coverage;
- host Decision ownership;
- private Core host adoption receipt fixture;
- rejected Lattice fast-path behavior.

Check-provider server Core evidence is limited to:

- `initialize` and narrowed read-only `initialized` grant handling;
- unsupported `initialize.protocolVersion` refusal before initialized state, callbacks, or Core
  coverage;
- pre-initialized `check/evaluate` rejection;
- grant-scoped, callback-only `workspace/listTree` and `workspace/readBlob` content access;
- valid `complete`, diagnostic, `incomplete`, `unsupported`, and `cancelled` Assessment results;
- typed JSON-RPC provider errors;
- malformed, stale, host-owned-field, and timeout rejection as non-passing evidence;
- provider outputs as Assessments only, never host Decisions or authority grants.

Interop evidence is limited to:

- the Open Engine reference host with the fake Core check provider;
- the Open Engine reference host with Opcore as an ordinary enrolled provider from manager-owned
  manifest state;
- a minimal independent host harness with the fake Core check provider;
- a minimal independent host harness with an Opcore provider entrypoint;
- unsupported or missing capability coverage surfaced as explicit Assessment/report detail;
- absence of privileged Opcore, old-tool, or temporary guardrail fast paths in interop tests,
  fixtures, and runners;
- private behavior evidence only, with no trust, authority, registry, provider approval,
  certification, stable API, or public-release claim.

Hostile-provider evidence is limited to:

- malformed initialize and malformed Assessment rejection;
- provider-minted host fields, stale freshness, missing required provider, unsupported required
  capability, incomplete coverage, provider error, cancellation, timeout, initialize/request crash,
  quarantine, missing authority, insufficient assurance, policy self-authorization, and direct-write
  risk as non-allow degraded coverage;
- optional provider degradation staying visible while clean required coverage may still allow;
- command-like edit output and untrusted edit launch rejection before apply;
- absence of privileged reference-provider, old-tool, or temporary guardrail fast paths in hostile
  tests, fixtures, and runners.

Edit/apply host evidence is limited to:

- provider EditPlans requested through `host/requestEditPlan` without provider writes;
- host-mediated positive apply of a canonical text edit;
- stale plan, CAS conflict, out-of-scope create, unknown proposal identity, denied validation, and
  indeterminate validation refusal before mutation;
- command-like, direct-write, malformed, and host-field-smuggling edit provider output rejection;
- missing authority and advisory assurance refusal with honest `gated`/`none` or advisory/`none`
  receipt fields;
- concurrent apply serialization or refusal;
- absence of privileged reference-provider, old-tool, or temporary guardrail fast paths in edit
  tests, fixtures, and runners.

Assurance evidence is limited to:

- advisory apply refusal reporting advisory/`none`;
- gated apply reporting gated/`none` plus gate validation and interactive apply boundaries;
- mediated-write and isolated authority labels being refused or downgraded when the host cannot prove
  those properties;
- direct-write provider output and untrusted edit launch refusal;
- accepted transaction-guarantee vocabulary with no staged-snapshot or workspace-transactional claim
  from the current implementation;
- provider crash, command-like edit output, denied validation, and indeterminate validation never
  producing misleading successful apply receipts.

Run the Core smoke suite:

```sh
npm run conformance:core
```

Generate the deterministic Core report:

```sh
npm run conformance:core:report -- --report /tmp/asp-core-conformance-report.json
```

Run the Core check-provider server suite:

```sh
npm run conformance:core:server
```

Generate the deterministic Core server report:

```sh
npm run conformance:core:server:report -- --report /tmp/asp-core-server-conformance-report.json
```

Run the interop matrix:

```sh
npm run conformance:interop
```

Generate the deterministic interop report:

```sh
npm run conformance:interop:report -- --report /tmp/asp-interop-conformance-report.json
```

The interop matrix requires `ASP_INTEROP_PROVIDER_BIN` to point to a real Opcore ASP JSON-RPC stdio
provider executable. `ASP_INTEROP_PROVIDER_ARGS` supplies its argv array. These inputs are ordinary
provider entrypoint configuration, not product shortcut commands, and do not grant provider
authority. Required Opcore assertions only pass when runtime evidence identifies provider `opcore`
and reports complete gate/Assessment coverage; missing, non-Opcore, incomplete, error, or unsupported
evidence fails.

Run the hostile-provider matrix:

```sh
npm run conformance:hostile
```

Generate the deterministic hostile-provider report:

```sh
npm run conformance:hostile:report -- --report /tmp/asp-hostile-conformance-report.json
```

Run the edit/apply host profile:

```sh
npm run conformance:edit
```

Generate the deterministic edit/apply host report:

```sh
npm run conformance:edit:report -- --report /tmp/asp-edit-host-conformance-report.json
```

Run the assurance honesty profile:

```sh
npm run conformance:assurance
```

Generate the deterministic assurance report:

```sh
npm run conformance:assurance:report -- --report /tmp/asp-assurance-conformance-report.json
```

The report schema is [`schemas/conformance-report.schema.json`](../../schemas/conformance-report.schema.json).
It applies to the host `CORE-*` report. The private adoption receipt fixture is
[`tests/conformance/fixtures/core/core-host-adoption-receipt.valid.json`](../../tests/conformance/fixtures/core/core-host-adoption-receipt.valid.json).
The `CORE-SERVER-*` report is checked by
[`scripts/conformance/core-server-report-catalog.ts`](../../scripts/conformance/core-server-report-catalog.ts)
to keep the server report separate from the host report schema. The `INTEROP-*` report is checked by
[`scripts/conformance/interop-report-catalog.ts`](../../scripts/conformance/interop-report-catalog.ts)
to keep interoperability evidence separate from trust, authority, certification, and public-standard
claims. The `HOSTILE-*` report is checked by
[`scripts/conformance/hostile-report-catalog.ts`](../../scripts/conformance/hostile-report-catalog.ts)
to keep hostile behavior evidence separate from trust, authority, certification, and public-standard
claims. The `EDIT-HOST-*` report is checked by
[`scripts/conformance/edit-host-report-catalog.ts`](../../scripts/conformance/edit-host-report-catalog.ts)
to keep edit/apply host behavior evidence separate from trust, authority, certification, public-standard,
and mediated-write guarantee claims. The `ASSURANCE-*` report is checked by
[`scripts/conformance/assurance-report-catalog.ts`](../../scripts/conformance/assurance-report-catalog.ts)
to keep assurance-mode honesty evidence separate from trust, authority, certification, public-standard,
isolated, mediated-write, staged-snapshot, and workspace-transactional claims. The requirement list is
[`requirements.md`](./requirements.md). The source-to-test map is [`traceability.md`](./traceability.md).

Report runners derive assertion results from TAP events. Required host, server, interop, hostile, edit, and assurance
assertion IDs include their negative cases. A required test that is absent, failed, skipped,
unsupported, or marked TODO is recorded as failed, missing, skipped, or unsupported coverage and
cannot produce a passing report.

Reports are private behavior evidence only. They do not grant trust, authority, registry inclusion,
provider approval, certification, stable public API status, or permission to replace existing
guardrails. Full host/server conformance, isolated assurance, workspace-transactional apply,
mediated-write apply, staged-snapshot apply, deployment-surface claims, repo dogfood, and Lattice
parity/old-tool retirement remain outside these scaffolds.

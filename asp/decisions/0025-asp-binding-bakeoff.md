---
adr: 25
title: Choose JSON-RPC stdio as the private ASP dogfood binding floor
status: accepted
date: 2026-06-23
---

# 25. Choose JSON-RPC stdio as the private ASP dogfood binding floor

## Context

ADR 0021 separated ASP semantics, wire bindings, and deployment surfaces. It left native JSON-RPC
stdio and a namespaced MCP extension as private binding candidates. Issue #13 ran the first private
bake-off against the current v0.1 semantic pack: `SnapshotRef`/`Baseline`, content-addressed
`ChangeSet`, provider Assessment/EditPlan data, host Decision data, coverage degradation, authority
evidence, assurance modes, transaction guarantees, and host-owned apply.

The binding must preserve the corrected topology:

- ASP is the protocol.
- A conforming host owns policy, freshness, capability aggregation, authority, assurance, mediated
  apply, and final decisions.
- Providers produce `inspect` data, `check` assessments, or `edit` plans.
- Lattice is an enrolled reference engine/server behind a conforming host, not ASP and not the host.
- `@the-open-engine/asp` may be the Open Engine reference/default host, but other conforming hosts
  remain valid.

## Decision

Native ASP JSON-RPC over stdio is the private dogfood binding floor for v0.1 host/provider and
harness/host work.

The private floor means:

- a trusted environment can launch a conforming host over stdio;
- providers can be spawned and supervised through the same JSON-RPC lifecycle;
- host/harness methods use the semantic outer seam: `host/status`, `host/capabilities`,
  `host/evaluateChangeset`, `host/queryInspect`, `host/requestEditPlan`, `host/applyProposal`, and
  `host/authority/status`;
- progress and cancellation are advisory utility messages; the terminal host result remains
  authoritative;
- domain objects remain transport-neutral and do not fork by binding.

A namespaced MCP extension remains a private experiment for compatibility/status work. It may become
authoritative only after a later accepted ADR proves host-driven required invocation, call-site
preservation, freshness equality, required coverage, authority grants, assurance-mode reporting,
cancellation receipts, and mediated apply without ordinary-tool ambiguity.

Ordinary MCP tools are rejected for authoritative gates. They may expose read-only status, inspect,
or debugging adapters, but they do not by themselves satisfy blocking `gate` call-sites.

LSP, SARIF, and BSP remain mapping/reference inputs only:

- LSP for capability negotiation, diagnostics, progress/cancellation, and workspace-edit patterns;
- SARIF for diagnostic/report export;
- BSP for build/task progress and structured diagnostics inspiration.

## Evidence

The bake-off evidence lives in:

- [`docs/bakeoffs/asp-binding-bakeoff.md`](../docs/bakeoffs/asp-binding-bakeoff.md)
- [`docs/bakeoffs/asp-binding-bakeoff-results.json`](../docs/bakeoffs/asp-binding-bakeoff-results.json)
- [`tests/bindings/binding-bakeoff.test.ts`](../tests/bindings/binding-bakeoff.test.ts)

The prototype covers both `json-rpc-stdio` and `mcp-extension` over shared fake host/provider
fixtures. It covers allow, deny, stale baseline, malformed provider output, cancellation,
unsupported capability, missing provider, missing authority, timeout, insufficient assurance,
Lattice fast-path bypass, edit-plan request, denied apply, and applied proposal.

Provider outputs are assessment/edit-plan data only. Recursive guards reject host-owned `decision`,
`pass`, `verdict`, `authority`, `assurance`, `transactionGuarantee`, `applyReceipt`, `shellCommand`,
and `disposition` fields. Host outputs carry decisions, call-site, policy digest,
`coverage.required`/`ran`/`degraded`, `validAsOf`, authority evidence, assurance mode, transaction
guarantee where relevant, and receipts.

## Relationship to earlier ADRs

- ADR 0001 is preserved. JSON-RPC 2.0 remains the private protocol-family base, and stdio is the
  private floor.
- ADR 0016 is preserved. The ASP outer seam remains native and semantic; adapters map to it rather
  than replacing it.
- ADR 0018 is preserved. The first Open Engine reference/default host can keep
  `asp host serve --repo <workspace>` over JSON-RPC stdio as its implementation target without
  becoming the only conforming host.
- ADR 0021 is preserved and narrowed for dogfood. Semantics, wire binding, and deployment surfaces
  remain separate; this ADR selects the private dogfood floor while leaving public binding and
  deployment standardization deferred.

This ADR does not supersede ADRs 0001, 0016, 0018, or 0021. It records the evidence-backed dogfood
choice made under those decisions.

## Consequences

- #8 conformance can keep assertion IDs semantic and add narrow binding adapters.
- #12 should build the reference/default host over JSON-RPC stdio first, with fake/minimal providers
  tested through the same contract as Lattice.
- #24 and #25 should hide binding details behind ACE host-client methods.
- #27, #28, and #29 should report the chosen private binding, latency, stale rejection, provider
  failures, assurance mode, transaction guarantee, and old-tool compatibility.
- MCP config, `.asp/asp.json`, `.asp/local.json`, `asp-server.json`, and Lattice paths remain
  non-authoritative deployment or compatibility surfaces.
- No package publish, public registry, certification program, stable manifest claim, or public ASP
  standard claim is introduced.

---
adr: 21
title: Separate ASP semantics, wire bindings, and deployment surfaces
status: accepted
date: 2026-06-22
---

# 21. Separate ASP semantics, wire bindings, and deployment surfaces

## Context

The v0.1 draft mixed three concerns: domain semantics, JSON-RPC wire shape, and ecosystem deployment
surfaces such as repository policy, local overrides, manifests, registry, and certification. External
review correctly identified that only the semantic contract is justified today.

## Decision

ASP v0.1 private work separates:

- **Semantic contract:** snapshots, changesets, assessments, edit plans, host decisions, coverage,
  assurance modes, and policy authority.
- **Wire bindings:** native JSON-RPC stdio and a namespaced MCP extension are private candidates until
  a bake-off proves which should become normative.
- **Deployment surfaces:** `.asp/asp.json`, `.asp/local.json`, `asp-server.json`, registries, and
  certification remain experimental until conformance and dogfood evidence justify standardization.

## Consequences

- Current JSON-RPC schemas are a private binding candidate, not an irrevocable public base protocol.
- MCP can be tested as a substrate without reducing ASP to ordinary model-controlled tools.
- Deployment files may exist as examples, but they must not be represented as stable public API.

---
adr: 16
title: Define a native ASP outer seam, with MCP and ACP as adapters
status: accepted
date: 2026-06-21
---

# 16. Define a native ASP outer seam, with MCP and ACP as adapters

## Context

The inner seam already lets a host run `sense`, `judge`, and `act` servers. Internal rollout raised a
different question: should a harness talk to ASP through MCP, through ACP, or through a native ASP
contract?

MCP is strong for exposing tools and read-only context. ACP is useful for editor-agent integration.
Neither naturally owns gate authority, host-computed verdicts, trust enrollment, or serialized write
transactions.

## Decision

ASP has a native harness-facing outer seam. MCP and ACP are adapter profiles over that seam, not the
normative contract.

The native outer seam owns:

- host status and composed capabilities;
- changeset evaluation and host verdicts;
- read-only sense queries;
- proposal requests and apply transactions;
- enrollment and trust visibility.

## Consequences

- A blocking gate binds to `asp`, not to a server-specific tool or adapter.
- MCP can expose ASP sense/status tools, but cannot be the source of gate authority unless it
  faithfully preserves the native verdict semantics.
- ACP can drive editor use cases, but the host remains the policy, verdict, and apply authority.

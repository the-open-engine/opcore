---
adr: 13
title: Serialized apply path with idempotency keys
status: accepted
date: 2026-06-16
---

# 13. Serialized apply path with idempotency keys

> Confirmed by the maintainer 2026-06-16 (was a provisional default).

## Context

"The host serializes conflicting acts" was asserted with no mechanism: no lock/queue, no ordering,
no proposal identity (review HM-7). Multiple harness drivers (agent loop, CI, pre-commit) can race.

## Decision

- **One serialized apply path per workspace** — at most one apply transaction in flight; others queue
  FIFO.
- **Idempotency key** — the host assigns a `proposalId` for every apply (propose and server-initiated
  `applyEdit`); dedup is on `(server, proposalId)`. A server-supplied key on the `applyEdit` path is
  namespaced under the authenticated server and never compared across servers.
- **Deterministic winner** — on overlapping-blob conflict, first-committed-wins; the loser is
  re-proposed against the new baseline, bounded to N retries (default 2), then rejected for the caller
  to resolve.

## Consequences

- Deterministic, race-free application; retries are dedupable by key.
- Serialization is per workspace, so independent workspaces still apply concurrently.
- Revisit only if a workspace needs concurrent non-overlapping applies for throughput.

## Supersession

[ADR 0024](./0024-supersede-server-initiated-apply-edit.md) supersedes the server-initiated
`applyEdit` branch while preserving the serialized per-workspace transaction and `(server,
proposalId)` idempotency semantics.

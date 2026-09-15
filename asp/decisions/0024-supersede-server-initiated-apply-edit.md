---
adr: 24
title: Supersede server-initiated applyEdit with host-authorized applyProposal
status: accepted
date: 2026-06-22
---

# 24. Supersede server-initiated applyEdit with host-authorized applyProposal

## Context

[ADR 0013](./0013-serialized-apply-with-idempotency.md) accepted serialized apply with
idempotency and included a server-initiated `applyEdit` path. Later host-boundary decisions made that
branch unsafe: providers must not decide whether a gate passes, claim apply authority, or trigger
workspace writes outside a host-owned apply transaction.

[ADR 0012](./0012-fix-application-user-initiated.md) requires explicit user or agent initiation,
[ADR 0019](./0019-apply-intent-authorizes-host-writes.md) treats authorized `host/applyProposal`
intent as sufficient for host writes, and
[ADR 0022](./0022-conforming-host-role-reference-host.md) requires the conforming host to coordinate
providers without Lattice-specific or provider-specific fast paths.

## Decision

ASP removes server-initiated `applyEdit` from the conforming write path. The only conforming
write-attempt surface is an authorized harness, user, or agent request to the host-owned
`host/applyProposal` operation.

Servers can still produce edit plans and upload proposal blobs through host-scoped callbacks. They
cannot initiate apply, schedule background writes, or convert an edit plan into gate authority. The
host validates the hypothetical changeset, serializes the workspace transaction, reports assurance
mode and transaction guarantee, and applies or stages only if the host decision permits it.

This ADR supersedes only the server-initiated `applyEdit` branch of ADR 0013. ADR 0013's
per-workspace serialization, deterministic conflict handling, and `(server, proposalId)` idempotency
semantics remain accepted for provider-originated edit plans. The host issues `proposalId` values and
derives `server` from the authenticated provider session.

## Consequences

- Specs and schemas must expose `host/requestEditPlan` and `host/applyProposal`, not a conforming
  server-owned apply method.
- A server request, notification, or watch result cannot be interpreted as write intent.
- Apply receipts are host-produced audit records, not provider verdicts.
- Legacy text that mentions `applyEdit` is historical unless it points to this supersession.

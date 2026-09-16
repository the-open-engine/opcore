---
adr: 19
title: Treat an authorized apply request as sufficient write intent
status: accepted
date: 2026-06-21
---

# 19. Treat an authorized apply request as sufficient write intent

## Context

ASP forbids servers from writing files directly. Internal dogfood also needs the host to apply edits
when an agent or harness explicitly asks for that, including in CoVibes, Orchestra, Lattice, and other
Open Engine repos.

The open question was whether every host apply should require an extra human approval prompt beyond
the initiating harness or user action.

## Decision

An authorized `host/applyProposal` request from the harness, user, or agent is sufficient write intent
for the host to attempt the apply transaction. The protocol does not require a second approval
ceremony.

Servers still cannot initiate autonomous writes. They propose edits. The host validates, serializes,
and applies only in response to authorized apply intent.

## Consequences

- Internal agents can use Lattice-backed ASP edits without direct server filesystem access.
- Background autonomous server-triggered writes remain forbidden.
- Product UIs may add confirmations, but they are UX policy above the protocol floor.

---
adr: 2
title: Borrow LSP vocabulary and patterns, not its wire
status: accepted
date: 2026-06-16
---

# 2. Borrow LSP vocabulary and patterns, not its wire

## Context

LSP is the closest prior art: a capability-negotiated, host-supervised protocol between an editor and
language intelligence. The temptation is to "just extend LSP." But LSP's core is the open-document
sync model (editor owns unsaved buffers, streams keystroke deltas), it is position-centric, and it
has no concept of gating, trust, or freshness-as-correctness.

## Decision

Align with LSP at the level of **concepts, terminology, and design patterns** — not the wire.

Adopt: capabilities/negotiation, supervised lifecycle (initialize/shutdown), `diagnostic`,
push-vs-pull diagnostics, `workspaceEdit` + apply (propose/host-applies), "workspace" scope,
progress/cancellation, "server" as the role noun.

Replace: document synchronization → a **changeset + baseline** model (the unit is a proposed delta
against a stamped tree revision, not an open buffer). This is the meaning of the "agent" in Agent
Server Protocol.

Add (no LSP equivalent): **gate**, **fail-class**, **trust tier / permissions / provenance**,
**arbitration**, **baseline / validAsOf**.

## Consequences

- The protocol is instantly legible to anyone who has written a language server.
- Existing LSP servers can be wrapped as sense/judge plug-ins via a **dedicated adapter** — not a
  passthrough. The adapter must synthesize content-addressed reads (LSP assumes file URIs), manufacture
  position-resilient fingerprints (LSP diagnostics have none), do before/after evaluation for
  `introduced`, and map crashes/timeouts to `failClass`. Still a real ecosystem-bootstrap lever, but a
  shim, not free.
- We carry none of LSP's editor-centric document machinery; the value is exactly the delta from LSP.

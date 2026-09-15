---
adr: 12
title: Fix application is user/agent-initiated; the host never auto-applies
status: accepted
date: 2026-06-16
---

# 12. Fix application is user/agent-initiated; the host never auto-applies

## Context

A diagnostic `fix` (`actRef` or `workspaceEdit`) feeds the apply transaction, which re-runs gating
judges, which can yield new fixes — a `judge → fix → act → judge` recursion with a real trust surface.
Who triggers a fix was open (review HM-4).

## Decision

A `fix` is applied only on **explicit agent or user action**. The host MUST NOT auto-apply fixes.
The recursion bound (max fix-chain depth + halt on equal-`fingerprint` reintroduction) remains as a
backstop against an agent that drives fixes in a loop.

## Consequences

- Smallest trust/recursion surface; predictable UX. An untrusted server's `fix` can never silently
  rewrite the tree.
- Auto-fix flows, if ever wanted, become a future explicit opt-in, never the default.

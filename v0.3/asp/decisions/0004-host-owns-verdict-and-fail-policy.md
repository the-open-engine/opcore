---
adr: 4
title: The host owns the verdict and fail-policy
status: accepted
date: 2026-06-16
---

# 4. The host owns the verdict and fail-policy

## Context

Servers are third-party and untrusted by default. If a server could declare its own pass/fail, or
decide whether its failure means "fail open," a malicious or buggy server could silently disable a
gate (label everything passing, or call its own crash `health` to wave itself through).

## Decision

**Servers report; the host decides.**

- `judge/evaluate` returns *diagnostics only* — never a pass/fail boolean. The host computes the
  **verdict** from severity, the server's trust tier, the call-site, and whether the server is enrolled
  as a gate ([ADR 0008](./0008-gating-is-enrollment.md)).
- Fail-open vs fail-closed is a host decision driven by the error's typed `failClass` and the
  call-site, never by the server's preference.
- The host may **cap** severity and **downgrade** an untrusted server's self-reported failClass.
- `act` proposes a `workspaceEdit`; the **host** validates and applies it. Server code never writes.

## Consequences

- Gate integrity does not depend on server honesty.
- The safety logic lives in one auditable place (the host), not scattered across plug-ins.
- See [ADR 0006](./0006-fail-open-on-health-closed-on-policy.md) for the fail-policy itself, and
  [host obligations](../spec/07-host-obligations.md) for the verdict algorithm.

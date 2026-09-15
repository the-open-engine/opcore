---
adr: 8
title: Gating is an operator enrollment decision, not a severity cap
status: accepted
date: 2026-06-16
---

# 8. Gating is an operator enrollment decision, not a severity cap

## Context

We want untrusted third-party judges to be useful, but a malicious or broken untrusted judge that can
block every commit is a denial-of-service. An early idea was to cap untrusted servers' severity so
they could never emit a blocking `error`. But that also prevents a legitimately-configured untrusted
judge from ever gating on a real violation — it defeats the point of plugging one in.

## Decision

Separate *can evaluate* from *does gate*.

- A `judge` capability means a server **can evaluate**. Whether its verdict **gates** at a given
  call-site is a separate, host-owned **enrollment** decision.
- `untrusted` servers are **advisory by default** — their diagnostics inform the agent but do not
  block — until an operator explicitly enrolls them as a gate.
- Effective-severity capping by trust tier remains, but as a secondary noise/abuse control, not as the
  primary DoS defense.

## Consequences

- An untrusted judge cannot block anything until a human chose to trust it as a gate. The commit-DoS
  surface is an explicit, auditable enrollment, not an emergent property of plugging a server in.
- A useful untrusted judge can still surface findings (advisory) immediately, earning the trust that
  justifies enrollment.
- The verdict computation in [host obligations](../spec/07-host-obligations.md) ranges over *enrolled
  gating* servers, not every server that returned diagnostics.

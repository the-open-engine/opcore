---
adr: 6
title: Fail open on health, fail closed on policy
status: accepted
date: 2026-06-16
---

# 6. Fail open on health, fail closed on policy

## Context

When a judge cannot evaluate, the host must decide whether to block. Blocking on every hiccup makes
the gate a nuisance that gets disabled; never blocking makes it theatre. The existing hooks already
learned the right asymmetry the hard way and encoded it by string-matching error text.

## Decision

The host decides from the error's typed **`failClass`** and the **call-site**:

| failClass | interactive edit | commit / ship gate |
|---|---|---|
| `health` (could not run) | fail **open** (warn, allow) | fail **closed** (block) |
| `contract` (ran wrong / skew) | fail closed | fail closed |
| `policy` / `input` | fail closed | fail closed |

- An unhealthy server must not block a human/agent mid-edit, but must not let a *commit* through.
- A server that ran but violated the protocol (`contract`) is a bug to fix — never a reason to skip
  the gate. Version skew is `contract`, not `health`.
- Every fail-open MUST be logged with server id, failClass, and call-site. Silent fail-open is
  forbidden.

## Consequences

- The open/closed decision is mechanical and uniform across all servers — it rides a typed field, not
  prose error matching.
- `failClass` becomes the single highest-value field in the protocol; it is part of every error.

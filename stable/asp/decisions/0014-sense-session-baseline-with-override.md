---
adr: 14
title: Sense answers as-of the session baseline, with optional override
status: accepted
date: 2026-06-16
---

# 14. Sense answers as-of the session baseline, with optional override

> Confirmed by the maintainer 2026-06-16 (was a provisional default).

## Context

Sense verbs (`references`/`callers`/`symbols`/…) carry no baseline field, yet the freshness rule says
"answer as-of the requested baseline" — ambiguous (review SI-5). Only `sense/impact` and `judge`/`act`
carry an explicit baseline.

## Decision

- Sense verbs answer as-of the **current session baseline**, issued at `initialized` and advanced by
  the host via a `workspace/baselineChanged` notification when the tree moves.
- A sense request MAY carry an optional `baseline` to ask about a specific revision (time-travel).
- `validAsOf.rev` MUST equal the effective (session or per-request override) baseline.
- Baselines are monotonic; a request's effective baseline is pinned at receipt; `baselineChanged`
  affects only later requests; a request whose baseline advanced mid-flight is not a freshness
  rejection; a server ignores a `baselineChanged` older than its current.

## Consequences

- Removes the ambiguity; the common case needs no per-request baseline.
- Requires a host→server `baselineChanged` notification in the lifecycle.
- Per-request override kept for explicit time-travel.

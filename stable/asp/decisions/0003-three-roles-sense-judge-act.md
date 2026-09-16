---
adr: 3
title: Three roles — sense, judge, act
status: accepted
date: 2026-06-16
---

# 3. Three roles — sense, judge, act

## Context

Stripping `rox`/`crg`/`cix` to their essence reveals the same three-part machine appearing three
times: read-only intelligence, pass/fail policy, and safe mutation. We need a role taxonomy that
third parties register against.

## Decision

Three roles:

- **sense** — read-only intelligence ("what is true"). Reference: `crg`.
- **judge** — pass/fail policy over a proposed change ("is this slop"). Reference: `rox`.
- **act** — atomic, reference-aware mutation ("change this safely"). Reference: `cix`.

A server MAY implement several roles; it declares them at `initialize`. For sense, the method surface
is a **typed core** (references, callers, impact) plus a `sense/query` escape hatch for tool-specific
verbs — precise capabilities without freezing the whole verb set.

## Consequences

- Clean separation of trust risk: sense (read) and judge (evaluate) are containable; act (mutate) is
  the dangerous one and is opened last, behind propose/host-applies.
- The three roles map onto LSP precedents (navigation, diagnostics, workspaceEdit), aiding adoption.
- Composition (act validated by judge, judge informed by sense) is expressed through the host, never
  peer-to-peer.

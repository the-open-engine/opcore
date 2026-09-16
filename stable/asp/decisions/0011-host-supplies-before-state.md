---
adr: 11
title: The host supplies before-state for incremental evaluation
status: accepted
date: 2026-06-16
---

# 11. The host supplies before-state for incremental evaluation

## Context

`introduced` is `after \ before` by fingerprint, which implies evaluating both states — O(2×) on
every gate call, punishing for wrapped tools with no incremental API (review SI-4). The `incremental`
capability existed but had no mechanism.

## Decision

`judge/evaluate` MAY carry `priorDiagnostics`: the host-cached before-state findings for the
changeset's `before` blobs.

- A server that advertised `incremental` MAY treat `priorDiagnostics` as the before-set and evaluate
  only the after-state, diffing by fingerprint.
- If `priorDiagnostics` is absent (cold/first call, or a non-incremental server), the server computes
  both states.
- The host populates it from a per-server diagnostic cache keyed by `(server, blob-set)` — safe to
  cache forever because blobs are immutable. The host caches the **full** after-state findings of each
  evaluated blob-set (running an `all` pass once if needed), so the before-set handed back is complete,
  not merely the previously-`introduced` subset.

## Consequences

- Warm gate calls drop to ~1× for incremental servers; naive servers still work unchanged.
- Adds a host-side, content-hash-keyed diagnostic cache. Correctness is exact (same fingerprint space,
  same `before` blobs).

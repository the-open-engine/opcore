---
adr: 7
title: Sense answers as-of the baseline (own index allowed)
status: accepted
date: 2026-06-16
---

# 7. Sense answers as-of the baseline (own index allowed)

## Context

Sense servers are usually stateful — they keep a warm index (a code graph, a type server) rather than
re-reading the tree per call. That index can lag the working tree. In an IDE a lagging index is a
cosmetic glitch; in a guardian loop, a sense answer computed against a stale graph can misroute a
judge's scope or mislead the agent. We need a freshness rule that does not forbid the warm index that
makes sense fast.

## Decision

A sense server MAY keep its own index, but it MUST answer **as-of the request's `baseline`**:

- On success, `validAsOf.rev` MUST equal the requested baseline `rev`.
- If its index is behind, it MUST reconcile first — pulling changed blobs via `workspace/readBlob` and
  updating incrementally — before answering.
- If it cannot reach the requested baseline, it MUST return a `health` error rather than answer
  against a stale graph.

## Consequences

- Freshness is correctness, not cosmetics: a stale answer is impossible to return silently.
- The content-addressed blob protocol does double duty — it feeds pure judges *and* incrementally
  refreshes stateful sense indexes.
- The host remains the single freshness authority; the server binds to the baseline it is given.
- Cost: a lagging server pays reconciliation latency on first call after a change, or fails health
  (which the host handles per the fail-policy). Accepted — correctness over a stale fast answer.

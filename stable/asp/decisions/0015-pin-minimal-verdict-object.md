---
adr: 15
title: Pin a minimal verdict object in v0.1
status: accepted
date: 2026-06-16
---

# 15. Pin a minimal verdict object in v0.1

## Context

The round-2 end-user lens (EU2-1/2/3) showed that every guarantee the *developer* experiences — why a
commit was blocked, which server and trust tier flagged it, advisory-vs-gating, a guaranteed
next-step, and whether a guardian silently went dark — lived only in the deferred `spec/09` outer-seam
stub. Freezing and certifying the inner-seam contracts first risked the first host inventing that
experience ad hoc, with later contracts forced to accommodate it.

## Decision

Pin a minimal **normative verdict object** in v0.1 (`schemas/verdict.schema.json`, host obligations
"Verdict object"). The host MUST, for any evaluation it surfaces:

- stamp each finding with authenticated **provenance** (`diagnostic.source`) + the server's
  **`trustTier`**, and mark its **`disposition`** (`gating` | `advisory`);
- guarantee a **`nextStep`** on every gating finding — from the server's `fix`/`help`/
  `codeDescription.href`, or a host-synthesized fallback;
- report **`coverage`** with a **`degraded`** list naming any server that failed open, was quarantined,
  or skewed.

Spec the **shape**, not the UI. The rest of the outer seam (harness-facing method surface, controls,
rendering) stays deferred to `spec/09`.

## Consequences

- "Failure names the next step" and "a dark guardian is visible to the user" become *host* guarantees
  backed by a wire shape, before contracts freeze.
- The host owns synthesizing a `nextStep` when a server provides none.
- Rendering remains outer-seam; only the data contract is pinned now.

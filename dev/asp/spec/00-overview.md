---
title: Overview
status: established
normative: false
summary: First-reader primer for ASP boundaries, host/provider responsibilities, capability families, decisions, receipts, and deeper protocol objects.
updated: 2026-06-23
---

# Overview

ASP is the code-change assurance boundary for agentic development.

| Protocol | Boundary | What it coordinates |
|---|---|---|
| LSP | language tools <-> IDE | editor language features |
| ACP | IDE/editor <-> agent | editor-agent collaboration |
| ASP | agent/harness/host <-> robustness engines | assurance over proposed code changes |

An ASP **host** asks **providers/servers** to **inspect**, **check**, or propose **edit** plans, then
the host returns a **decision** and a **receipt**. Providers/servers produce assessments or edit
plans. Hosts produce decisions.

## Minimal Flow

1. A harness asks the host for status.
2. The host reports ready/degraded/unavailable status and which check providers are required.
3. The harness sends a candidate change to the host for a gate call-site.
4. The host calls the required check provider.
5. The provider returns an assessment with diagnostics, evidence, coverage, freshness data, provider
   metadata, timing, and cache metadata.
6. The host combines policy, required coverage, provider authority, and assessment results.
7. The host returns `allow`, `deny`, or `indeterminate` plus a receipt.

The receipt is host-authored. It records what ran, which provider evidence contributed, which policy
digest was used, what coverage was achieved or degraded, and what assurance the host actually
achieved.

## Capability Families

| Capability | Provider/server output | Host responsibility |
|---|---|---|
| **inspect** | read-only code intelligence, such as references, impact, and flows | route the query, bind freshness, and compose results |
| **check** | an assessment of a candidate change | compute the decision for the call-site |
| **edit** | an edit plan or workspace-edit proposal | decide whether and how the proposal may be applied |

Older documents may use `sense`, `judge`, and `act` as shorthand. Normative conformance attaches to
`inspect`, `check`, and `edit`.

## Host/Provider Split

ASP uses a star topology:

```text
harness or agent -> host -> provider/server
```

The harness talks to the host. The host talks to providers/servers. Providers/servers do not compose
directly with one another and do not decide whether a gate passes.

The host owns capability negotiation, policy, freshness, provider aggregation, decision production,
receipt production, authority status, and mediated apply. A provider/server owns the capability work
it advertises: inspect facts, check assessments, or edit plans.

## Core First

The [ASP v1.0 Core Profile](./11-core-profile.md) defines the smallest adoption path:

- host status
- host capabilities
- provider initialize/initialized
- host blob/tree callbacks
- provider `check/evaluate`
- host `host/evaluateChangeset`
- host-authored allow/deny/negative decision receipts

Inspect, edit, apply, deployment surfaces, and implementation-parity work remain optional non-Core
profiles unless a later ADR promotes them.

## Deeper Protocol Objects

The primer intentionally leaves dense machinery to later chapters:

- [Data model](./03-data-model.md): SnapshotRef/Baseline, ChangeSet, Assessment, EditPlan,
  Diagnostic, and FailClass.
- [Host obligations](./07-host-obligations.md): policy, aggregation, freshness, coverage,
  authority, assurance, budgets, and mediated apply.
- [Outer seam](./09-outer-seam.md): harness-to-host status, evaluation, inspect, edit, apply, and
  receipt payloads.
- [Core Profile](./11-core-profile.md): the private host/provider/check adoption gate and evidence
  bundle.

## Document Status

| Area | Status |
|---|---|
| Overview, architecture, transport+lifecycle, data model | established |
| Inspect/check/edit capability families | established |
| Historical sense/judge/act compatibility chapters | draft, non-normative |
| Host obligations, conformance | established |
| Outer seam, installation and discovery | draft |
| Core Profile | established |

ASP v1.0 centers on host-produced decisions over provider-produced assessments. Binding and
deployment surfaces remain private draft work.

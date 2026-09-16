---
adr: 26
title: Promote the ASP Core wire contract to v1.0
status: accepted
date: 2026-09-08
---

# 26. Promote the ASP Core wire contract to v1.0

## Context

ASP Core has an implemented provider lifecycle, immutable change input, bounded content callbacks,
provider assessments, decision ownership, coverage rules, freshness checks, and conformance
fixtures. Opcore Zero ships four provider identities against that contract. Continuing to call this
working contract `0.1-draft` makes the maturity label contradict the implemented boundary.

The optional inspect, edit, discovery, registry, and public-governance surfaces do not need to be
declared stable for the Core check contract to have a stable version.

## Decision

Promote the maintained protocol definition and Core Profile to ASP v1.0. The canonical identifiers
are now:

- protocol: `asp/1.0`;
- check capability: `check/1.0`;
- edit capability in the optional profile: `edit/1.0`;
- server manifest: `asp-server/1.0`;
- Core conformance profile: `asp-core-v1.0`.

The Core Profile status is established. The v1.0 change does not transfer decision authority to a
provider, widen its content grant, add apply authority, or make optional deployment surfaces part of
Core. Providers still return assessments. A conforming decision-maker still owns policy,
aggregation, freshness, authority, the final decision, and receipts.

Protocol negotiation is exact. An implementation advertising only `asp/1.0` rejects `asp/0.1` as
unsupported; it does not silently reinterpret the older wire identifier.

The accepted ADRs that describe the path to the earlier draft remain historical records. The
schemas, current specification, examples, fixtures, runtime constants, manifests, and tests move to
the v1.0 identifiers together. `SOURCE.json` continues to record the immutable upstream starting
point and now binds the exact Opcore Zero-maintained v1.0 definition.

## Consequences

Opcore Zero can present Agent Server Protocol v1.0 as an implemented contract without presenting
unfinished registry, certification, or package-governance work as complete. Any future breaking
wire change requires a new protocol version and matching changes across the definition and
implementation.

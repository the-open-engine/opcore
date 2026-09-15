---
adr: 23
title: Model assurance modes and authority axes separately from trust labels
status: accepted
date: 2026-06-22
---

# 23. Model assurance modes and authority axes separately from trust labels

## Context

The original trust-tier model (`first-party`, `certified`, `untrusted`) collapsed identity,
integrity, conformance, isolation, and authority. It also implied more safety than a deployment can
enforce: a local subprocess with repository write access can bypass a proposal-only protocol.

## Decision

ASP distinguishes:

- **Identity:** who published or owns the provider.
- **Integrity:** the exact artifact/package digest or pinned version.
- **Conformance:** whether the provider implements the protocol correctly.
- **Isolation:** what the provider can read, write, execute, or transmit.
- **Authority:** whether policy allows its assessment to satisfy a named gate.

ASP also reports the achieved **assurance mode**:

- `advisory`: host can run/report checks but cannot enforce the boundary.
- `gated`: host controls a commit, merge, CI, or similar boundary.
- `mediated-write`: intended writes pass through the host.
- `isolated`: server cannot write the real worktree and has constrained data/network access.

## Consequences

- Certification never grants blocking authority automatically.
- Gate authority must be explicitly granted to a pinned provider identity for a named requirement.
- "Safe mutation" claims must name the achieved assurance mode and transaction guarantee.
- Conformance tests must include malicious, stale, missing, and degraded provider cases.

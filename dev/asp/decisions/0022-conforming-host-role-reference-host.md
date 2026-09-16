---
adr: 22
title: Define a conforming host role and ship the Open Engine host as a reference implementation
status: accepted
date: 2026-06-22
---

# 22. Define a conforming host role and ship the Open Engine host as a reference implementation

## Context

ASP needs a coordinator that owns policy, freshness, assessment aggregation, decisions, and mediated
apply. That coordinator does not have to be a centralized Open Engine runtime. It can be embedded in
an editor, harness, CI system, or another vendor implementation.

## Decision

ASP requires a **conforming host role**, not a mandatory centralized host implementation.

The Open Engine may build `@the-open-engine/asp` as the private reference/default host implementation.
It must pass the same conformance suite expected of any other host and must not gain privileged
Lattice-specific behavior.

## Consequences

- Docs must say "a conforming ASP host" when describing the standard.
- Docs may say "`@the-open-engine/asp` reference host" when describing our implementation path.
- ASP servers must be testable against fake and independent hosts, not only the Open Engine host.
- Harnesses may embed a host or invoke the reference host.
- ACE is one optional harness/client. ACE may consume a configured conforming host through an adapter,
  but it does not own ASP host distribution, host startup policy, provider authority, Lattice
  provisioning, or ASP release gating.

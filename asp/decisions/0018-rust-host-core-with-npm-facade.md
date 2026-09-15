---
adr: 18
title: Ship the first Open Engine ASP host as a Rust core with an npm facade
status: accepted
date: 2026-06-21
---

# 18. Ship the first Open Engine ASP host as a Rust core with an npm facade

## Context

ASP needs a host runtime that can be installed independently of ACE and independently of Lattice. The
host owns transport, process supervision, policy, trust, budgets, verdict composition, and apply
serialization. Those are runtime concerns where predictable binaries and strict IO boundaries matter.

At the same time, Open Engine repositories already use Node/npm distribution paths heavily.
ACE may later consume this host through a client adapter, but ACE must not be the carrier,
distribution mechanism, startup-policy owner, provider-authority owner, or release gate for the ASP
host.

## Decision

The first Open Engine host implementation is a Rust runtime distributed with an npm facade:

- command: `asp`;
- package: `@the-open-engine/asp`;
- conformance floor: `asp host serve --repo <workspace>` over JSON-RPC stdio;
- optional warm transport may be added later if it preserves stdio semantics.

Lattice is not the host package. Lattice is an ASP server implementation that can be installed and
enrolled by policy.

## Consequences

- Internal repos can depend on the host without making ACE ship Lattice.
- ACE adoption is downstream dogfood evidence, not a prerequisite for ASP host delivery.
- The host can enforce sandboxing, budgets, and serialized apply as a small native core.
- npm remains the convenient acquisition path for JavaScript-heavy repos and CI.

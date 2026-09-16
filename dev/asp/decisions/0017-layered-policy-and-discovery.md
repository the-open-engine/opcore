---
adr: 17
title: Use layered declarative policy and trusted installed server manifests
status: accepted
date: 2026-06-21
---

# 17. Use layered declarative policy and trusted installed server manifests

## Context

An ASP-enabled repository needs to say which robustness engines are required without letting a pull
request define arbitrary commands that execute as blocking gates. We also need local development
escape hatches while protecting shared gates.

## Decision

Use three layers:

- `.asp/asp.json` is versioned repository policy. It is declarative and cannot contain arbitrary gate
  commands.
- `.asp/local.json` is ignored local override policy. It can point at local builds and experiments,
  but cannot certify a server or weaken shared gates.
- `asp-server.json` is an installed server manifest. It can name an entrypoint because it belongs to
  an installed artifact with provenance and fingerprint evidence.

Policy changes are two-phase: a branch is evaluated under the trusted base policy, and new policy
activates only after merge or explicit trusted approval.

## Consequences

- ACE and other harnesses discover an installed ASP host instead of provisioning Lattice directly.
- A malicious policy edit cannot disable the gate that reviews it.
- Local dogfood can move quickly without turning local commands into shared trust roots.

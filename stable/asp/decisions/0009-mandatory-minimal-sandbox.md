---
adr: 9
title: Untrusted servers run under a mandatory minimal sandbox
status: accepted
date: 2026-06-16
---

# 9. Untrusted servers run under a mandatory minimal sandbox

## Context

v0.1 left supervision/sandboxing "implementation-defined," which undercut the headline claim that
untrusted third-party servers are safe to run (review HM-2). The trust story rests on isolation that
the spec didn't actually require.

## Decision

All servers run under a normative minimal sandbox; for `untrusted` it is mandatory and non-waivable:

- **Process isolation** — a separate process, no shared host memory.
- **Resource limits** — the grant carries a `resourceLimits` block: `cpu`, `memory`, `wallclock`, and
  open-`fd` caps. The host builds the sandbox from the grant.
- **Egress default-deny** — `network:false` means no network; `network:true` is valid only with a
  `networkAllowlist` of destinations in the grant. `network:true` without one is a `contract` rejection.
- **No filesystem** — all bytes come through `workspace/readBlob` (already required); the sandbox
  exposes no direct FS.

The isolation *mechanism* (container / seccomp / microVM / WASM) and concrete limit *values* are
host-config, but the contract — isolation + limits + egress-deny + no-FS — is mandatory.

## Consequences

- `untrusted` becomes a genuinely shippable tier; the trust claim is backed by an enforced boundary.
- Servers must run as a separate process and tolerate resource caps and refusals.
- Supersedes the "sandbox is implementation-defined" deferral in host-obligations.

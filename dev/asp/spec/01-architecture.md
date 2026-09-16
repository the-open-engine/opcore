---
title: Architecture
status: established
normative: true
summary: Host-centric topology, policy-pinned authority boundaries, capability seams, the shared spine, and the threat model.
updated: 2026-06-22
---

# Architecture

> **2026-06-22 correction:** Earlier drafts used `sense`, `judge`, and `act` as normative roles and
> `first-party` / `certified` / `untrusted` as a trust ladder. The current contract uses
> `inspect`, `check`, and `edit` capability families. Trust is split into identity, integrity,
> conformance, isolation, and explicit authority grants. See
> [ADR 0021](../decisions/0021-separate-semantics-wire-and-deployment.md),
> [ADR 0022](../decisions/0022-conforming-host-role-reference-host.md), and
> [ADR 0023](../decisions/0023-assurance-modes-and-authority-axes.md). Governance and public-release
> posture are tracked in [the governance draft](../docs/governance/governance-draft.md).

## Topology: a star around the host

```
        harness (agent loop / CI / pre-commit)
                       │  outer seam (semantic)
                    ┌──┴──┐
                    │ HOST │  enrollment · negotiation · freshness · policy · arbitration · mediated apply
                    └──┬──┘
        inner seam (host-to-provider ASP protocol)
        ┌──────────────┼──────────────┐
   inspect server  check server     edit server
   (legacy sense)  (legacy judge)   (legacy act)
   (crg)           (rox)            (cix)
```

The diagram is logical, not a process-count requirement. One installed server may advertise several
capability families; for example, Lattice is expected to be one multi-capability ASP
engine/server exposing `inspect`, `check`, and `edit`. That aggregation does not make the server a
host.

The host is the only component the harness binds to, and the only one that applies edits. Servers
MUST NOT communicate with each other or compose provider-to-provider; every cross-capability
interaction (an edit proposal validated by check providers, a check informed by inspect providers) is
mediated by the host. This is what makes trust, freshness, and arbitration enforceable in one place.

Lattice, fake providers, third-party providers, and Open Engine dogfood providers all use the same
host-to-provider contract. A Lattice-specific direct gate, authority grant, freshness authority,
assessment aggregation, host decision, apply/staging, assurance-mode, or transaction-guarantee path
is non-conforming even when the selected host is the Open Engine reference/default host
(`@the-open-engine/asp`).

## Authority evidence

The host assigns every registered server explicit authority evidence. A server's declared
capabilities and requested permissions are inputs; gate authority is granted only by trusted policy
for a pinned provider identity/version/digest, named requirement, and named call-site (see
[host obligations](./07-host-obligations.md)). Repository config, local overrides, installed
manifests, package provenance, registry labels, and certification labels cannot weaken trusted policy
or authorize candidate changes by themselves.

| Axis | Meaning |
|---|---|
| Identity | Who published or owns the provider. |
| Integrity | Which exact artifact/package digest is running. |
| Conformance | Whether the provider implements ASP correctly. |
| Isolation | What the provider can read, write, execute, or transmit. |
| Authority | Whether policy allows the provider to satisfy a named gate. |

Legacy labels such as `first-party`, `certified`, and `untrusted` may be shown as shorthand, but they
MUST NOT grant blocking authority by themselves.

Every server runs under a mandatory minimal sandbox — process isolation, `resourceLimits`
(cpu/memory/wallclock/fd) from the grant, egress default-deny, and no direct filesystem
([ADR 0009](../decisions/0009-mandatory-minimal-sandbox.md)). Lower-assurance deployments cannot
waive isolation and still claim stronger assurance modes.

## The six host enforcement points

Because servers are untrusted by default, the host intervenes at these points, specified
normatively in [host obligations](./07-host-obligations.md):

1. **Permission cap** — grant a policy-bounded subset of requested permissions; build the sandbox from it.
2. **Provenance stamp** — overwrite each diagnostic's `source` with the authenticated server id.
3. **Fail-class override** — may downgrade a provider's self-reported `failClass` by authority,
   isolation, and policy.
4. **Freshness** — issue the `baseline`; reject any answer whose `validAsOf` doesn't match.
5. **Apply is host-executed** — edit providers only propose `EditPlan`/`WorkspaceEdit` payloads; the host validates, writes, and reports the achieved transaction guarantee.
6. **String containment** — treat every server-supplied string as untrusted data, never instructions.

## Threat model

Untrusted servers run inside the dev loop with the ability to read code, block commits, and propose
mutations. The protocol is designed against:

- **Exfiltration** — a server reads source it has no business reading. → least-privilege reads
  enforced at the blob boundary (see [data model](./03-data-model.md)).
- **Gate-disable** — a server silently passes everything, returns a decision, or labels its own failure
  `health` to fail open. → host computes the decision envelope; host caps/downgrades fail-class and
  reports degraded coverage.
- **Commit-DoS** — a server blocks every change. → host owns the decision envelope and can quarantine
  a server by policy; coverage/timeout policy bounds a single server's influence.
- **Tree-corruption** — a malicious edit provider writes garbage. → edit providers never write; the host applies
  after validating.
- **Provenance spoofing** — a server blames another. → host stamps `source`.
- **Prompt-injection** — a server puts agent-directed instructions in `message`/`code`/`fix.args`,
  which the host would otherwise relay to the LLM agent. → string containment (enforcement point 6).
- **Policy-confusion** — mutable repository policy, local overrides, installed manifests, registry or
  certification labels, first-party labels, or package provenance are treated as trust roots. →
  trusted policy is separate from those artifacts; they cannot grant authority or weaken a gate by
  themselves.

## The two seams (ownership)

- **Outer seam (harness <-> host)** is a semantic contract first. ADR 0025 chooses native JSON-RPC
  stdio as the private dogfood binding floor and leaves MCP-extension as a private
  compatibility/status experiment. The harness sees one unified capability surface regardless of what
  is plugged in behind the host.
- **Inner seam (host ↔ server)** is the conformance protocol. Third parties implement it. Versioned
  per server and negotiated at `initialize`; on incompatibility the host refuses the server rather
  than degrading silently.

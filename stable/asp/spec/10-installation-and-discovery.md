---
title: Experimental installation and discovery
status: draft
normative: true
summary: Private experimental manager, host acquisition, server discovery, logical repository policy, provider manifests, local overrides, authority grants, and missing-host behavior.
updated: 2026-06-24
---

# Experimental installation and discovery

ASP intentionally separates **manager UX**, **host acquisition**, **server discovery**, **logical
policy**, **provider launch**, and **authority grants**. This chapter is private draft material; the
filenames and schemas here are not public API, stable manifests, stable descriptors, release gates,
registries, launch authority, gate authority, certification, or trust roots. Governance posture is in
[the governance draft](../docs/governance/governance-draft.md).

The repository does not ship a private copy of the host, and a harness such as ACE does not bundle
Lattice or carry ASP as a hidden dependency. ASP ships independently as a manager/runtime package such
as `@the-open-engine/asp` / `asp`. The manager may launch the Open Engine reference host, discover and
supervise installed ASP servers, install agent-root hooks/skills, and help users enroll repos. The
environment still supplies or embeds a conforming ASP host for authoritative decisions. The
repository declares logical assurance requirements. The environment, organization, or manager decides
how servers are installed and launched.

The [Core Profile](./11-core-profile.md) deliberately excludes deployment surfaces from the tiny
first host/provider/check adoption path. Manager daemon behavior, server catalogs, setup wizards,
agent-root hooks/skills, `.asp/asp.json`, `.asp/local.json`, `asp-server.json`, dogfood wiring, ACE
integration, and reference-engine parity remain optional non-Core profiles and cannot replace Core
adoption receipts.

## 1. Boundary matrix

| Surface | May express | Must not express | Activation / failure rule |
|---|---|---|---|
| `asp` manager CLI/daemon | User-level server discovery/install, server supervision, agent-root setup, repo enrollment, status/doctor output, local advisory defaults, and host launch for the Open Engine implementation path. | Protocol semantics by fiat, mandatory central service behavior, gate authority without policy, certification, public registry trust, or Lattice-specific fast paths. | It is a trusted local product surface when installed by the user/org. It must still produce or consume host-authored decisions and receipts for gates. |
| Server catalog | Discoverable official-supported, community-listed, partner/paid, closed-source, and local-dev ASP servers with metadata and install hints. | Trust roots, automatic gate authority, required registry membership, conformance claims without evidence, or exclusion of non-catalog local servers. | Catalog listing can help installation, but a server satisfies gates only through separate identity, integrity, conformance, isolation, and authority checks. |
| `.asp/asp.json` repository policy | ASP version, capability requirements, gates, budgets, adapter expectations, assurance requirements, pinned provider identity/version/digest/conformance, and authority requirements. | Host implementation selection, shell commands, scripts, executable paths, launch strings, package discovery, certification programs, registry trust, or provider launch authority. | Candidate edits are evaluated under trusted base policy or a non-weakenable organization floor. A candidate policy cannot authorize or weaken gates for the same change. |
| `.asp/local.json` local override | Local advisory experiments, unpublished builds, diagnostics, and presentation preferences. | Shared gate weakening, shared authority grants, certification, trust roots, missing-host fail-open for shared gates, or shared authoritative decisions. | Ignored by source control. It can affect local advisory behavior only. |
| `asp-server.json` installed manifest | Installed provider metadata, protocol versions, capability hints, structured entrypoint, artifact digest, provenance, and explicit access expectations. | Trust roots, gate authority, registry authority, certification authority, inherited environment trust, or shared policy requirements. | The host/environment validates identity, integrity, conformance, isolation, access grants, and authority before launch/enrollment. Stale, malformed, or incompatible manifests cannot silently satisfy gates. |
| Trusted environment/org/installation config | Host and provider launch behavior, protected policy floors, sandboxing, network/secret/data grants, and installed-manifest validation. | Mutable candidate-policy shortcuts or provider authority without explicit pins. | It is the only place blocking gate launch behavior may come from. |
| Authority grants | Named provider id/version/integrity/identity/conformance pins for a requirement and call-site. | Authority from manifest presence, package scope, provenance, first-party label, certification, registry membership, local install, or repository policy alone. | Identity, integrity, conformance, isolation, and authority are validated as separate axes. |
| Missing/degraded gate outcomes | Explicit deny or indeterminate for required `gate` coverage with `coverage.required`, `coverage.ran`, and `coverage.degraded`. Optional coverage may degrade. | Silent pass, optional-provider degradation reported as complete coverage, or local override changing shared gate behavior. | Missing host/provider, stale baseline, malformed manifest, missing authority, unsupported capability, insufficient assurance, timeout, or schema mismatch fails closed or becomes indeterminate for `gate`. |

## 2. Manager and host acquisition

The first Open Engine distribution is expected to be a global developer manager with a host runtime
behind it:

```sh
npm install -g @the-open-engine/asp
asp setup --dry-run
asp setup
asp up
asp host serve --repo <workspace>
```

`asp setup` is the explicit trusted onboarding action for private local developer installs. It plans
or installs supported agent-root guidance and advisory hook shims, reports backups, and accepts
`--agent <name>`, `--repo <path>`, `--dry-run`, and `--json`. Package installation alone MUST NOT
silently mutate agent roots or start long-lived processes. Private server catalog behavior,
supported server offers, and local/partner server links are manager-owned discovery/setup state;
repository enrollment is manager-owned local state and does not mutate shared repository policy.

Installed hooks call the manager-owned advisory entrypoint:

```sh
asp agent-hook --agent <agent> --event <event> --json
```

The hook command checks manager status, degrades with repair guidance when the daemon is down, and
does not start the daemon, call providers directly, produce host decisions, or grant gate authority.

The current private manager lifecycle is:

- `asp up` starts the user-level manager daemon if it is not already running;
- `asp down` stops it;
- `asp status` reports manager, host, server, agent, and repo state;
- `asp doctor` explains missing or degraded setup;
- `asp setup` installs private local agent guidance and advisory hook shims only when explicitly run;
- `asp agent-hook` reports advisory hook status without provider calls or gate authority;
- `asp server ...` discovers, installs, links, lists, checks, and removes ASP servers;
- `asp repo ...` records local repo enrollment intent under `ASP_HOME`;
- `asp check --repo ...` evaluates changed or staged content through the conforming Core host;
- `asp ci verify --repo ...` verifies host-authored receipts for protected CI and fails closed on
  provider-only output, direct Lattice output, missing authority, stale baselines, and weakened local
  overrides.

Other conforming hosts MAY be embedded in an editor, harness, CI system, or vendor runtime. A
repository policy MUST NOT select, require, or lock in the Open Engine host implementation; it MAY
require protocol versions, capabilities, assurance modes, and provider identities. Host acquisition is
owned by the trusted environment or installed manager, not by a mutable branch.

[ADR 0025](../decisions/0025-asp-binding-bakeoff.md) chooses JSON-RPC over stdio as the private
dogfood binding floor. Trusted environment, organization, editor, CI, or harness configuration MAY
launch the conforming host over that floor. Repository policy, MCP config, `.asp/local.json`,
`.asp/asp.json`, `asp-server.json`, provider descriptors, and Lattice paths are not host selection,
launch authority, or gate authority by themselves.

## 3. Server discovery and manager catalog

The private manager exposes a server catalog so users can discover and record many ASP servers, not
only Lattice. Catalog categories are descriptive:

- `official-supported`: Open Engine-maintained or Open Engine-supported servers. Lattice is expected
  to start here.
- `community-listed`: third-party servers referenced for discovery.
- `verified-conformant`: servers with current conformance evidence for a named profile.
- `partner-paid`: partner, paid, private, or closed-source servers that require explicit install and
  authentication steps.
- `local-dev`: local unpublished servers linked from a developer machine.

These categories MUST NOT collapse trust axes. Official support, catalog listing, paid status,
closed-source distribution, local installation, or conformance evidence alone does not grant
authority. Shared gates require explicit policy grants for a named requirement and call-site.

The manager also allows non-catalog servers through installed manifests or local links. Those
servers default to advisory and minimal access until the user or organization grants stronger
authority through trusted policy. Manager server state is stored under `$ASP_HOME/servers` and does
not mutate repository policy, agent roots, or shared gates.

## 4. Repository policy

Experimental versioned repository policy lives at:

```text
.asp/asp.json
```

The file is declarative. It can name required protocol versions, capabilities, provider identities,
authority grants, assurance modes, gates, budgets, and adapter expectations. It MUST NOT contain
arbitrary shell commands, npm scripts, make targets, hook commands, executable paths, launch strings,
or other command selectors for blocking gates. It MUST NOT select a specific host implementation,
including `@the-open-engine/asp`, Lattice, ACE, or a vendor host. `.asp/asp.json` is not a trust root,
launch authority, or gate authority by itself.

Blocking gate execution comes from trusted environment and policy state, not from mutable repository
commands. Launch instructions are supplied by:

- protected CI or harness configuration;
- organization-controlled host configuration;
- installed provider manifests with pinned identity and integrity evidence.

This prevents a pull request from weakening its own gate by changing versioned repo policy. A
candidate policy file can be parsed and reported as pending, but the current changeset is evaluated
under trusted base policy or an organization-level non-weakenable floor.

## 5. Local overrides

Developer-local overrides live at:

```text
.asp/local.json
```

This file MUST be ignored by source control. Local overrides can add unpublished builds, extra
diagnostics, presentation preferences, or non-blocking experiments. A local override cannot certify a
provider, weaken shared gates, grant shared authority, change missing-host behavior for shared gates,
become a trust root, or produce a shared authoritative decision.

## 6. Server manifests

Installed ASP servers may advertise themselves with the experimental manifest:

```text
asp-server.json
```

The manifest names the provider id, version, supported protocol versions, capabilities, entrypoint,
identity, artifact digest, access expectations, and publisher provenance.

Unlike `.asp/asp.json`, an installed manifest MAY contain structured executable plus argument arrays
because it is part of an installed artifact, not mutable repository policy. Its presence on disk does
not establish trust, registry inclusion, launch authority, or gate authority. The host or environment
still validates identity, integrity, conformance, isolation, and authority before launching or
enrolling the provider.

Manifest entrypoints are structured launch hints: `entrypoint.transport`, `entrypoint.bin`, and
`entrypoint.args`. A single shell string is invalid. Hosts that launch an installed manifest MUST
reject relative or PATH-resolved `entrypoint.bin` values and use a trusted manager/artifact working
directory, not the candidate repository, for manifest-launched providers. Filesystem, network,
secret, environment, and data-access expectations must be declared before a trusted host/environment
may grant them. Ambient process environment, inherited filesystem reach, network reach, data reach,
or secret access is never trusted by default.

## 7. Gate trust

Shared blocking gates MUST enroll only pinned providers authorized by trusted policy for a named
requirement and named call-site. Authority is separate from provenance or conformance.

- Identity says who published or owns the provider.
- Integrity says which exact artifact/package digest is running.
- Conformance says whether the provider implements ASP correctly.
- Isolation says what the provider can read, write, execute, or transmit.
- Authority says whether its assessment can satisfy a named gate.

Repository config, local overrides, installed manifests, package provenance, first-party labels, and
future certification labels are not trust roots. Certification, if later approved, can contribute to
policy, but certification MUST NOT automatically grant gate authority.

## 8. Missing host and missing server behavior

For `gate` call-sites:

- missing conforming host: fail closed;
- incompatible host version: fail closed;
- stale baseline: explicit degraded coverage plus indeterminate or fail closed per policy;
- missing required provider: explicit degraded coverage plus indeterminate or fail closed per policy;
- unavailable required provider: explicit degraded coverage plus indeterminate or fail closed per
  policy;
- quarantined required provider: explicit degraded coverage plus indeterminate or fail closed per
  policy;
- incompatible required provider: explicit degraded coverage plus indeterminate or fail closed per
  policy;
- stale, malformed, or incompatible provider manifest: explicit degraded coverage plus indeterminate
  or fail closed per policy;
- missing provider authority: explicit degraded coverage plus indeterminate or fail closed per
  policy;
- unsupported required capability: explicit degraded coverage plus indeterminate or fail closed per
  policy;
- insufficient assurance mode: explicit degraded coverage plus indeterminate or fail closed per
  policy;
- timeout: explicit degraded coverage plus indeterminate or fail closed per policy;
- schema mismatch: fail closed;
- candidate policy self-authorization: pending policy plus indeterminate or fail closed under trusted
  base policy;
- optional provider unavailable: degraded coverage, not automatic failure unless policy requires it.

For `interactive` call-sites, a missing host or server SHOULD warn and fail open so the developer can
continue working while setup is repaired.

## 9. Harness responsibilities

A conforming harness:

- embeds or invokes a conforming ASP host;
- passes the workspace, call-site, changeset, and apply intent to the host;
- renders host decisions without stripping provenance, authority, assurance mode, next-step, or
  coverage degradation;
- does not launch role servers directly for blocking gates;
- does not make Lattice an ACE-managed artifact.
- does not own ASP host startup policy, provider authority, provider provisioning, or ASP release
  gating unless it is itself acting as a trusted conforming host implementation.
- keeps binding mechanics behind a host-client seam, initially the private JSON-RPC stdio floor from
  ADR 0025, so hook/status/inspect code does not depend on provider paths or MCP tool calls.
- may integrate by speaking the outer seam directly, by embedding a conforming host, by using an ASP
  SDK/client, or by calling the installed manager daemon. The manager path is meant to be easy, not
  mandatory.

For ACE specifically, the private migration target is narrower: ACE may consume a configured
conforming host, initially the Open Engine reference host where the trusted environment supplies it,
through a thin host-client adapter. ACE is one optional harness/client, not the architecture center
and not an ASP release gate. Lattice remains an installed ASP server selected by trusted policy and
enrolled behind the host. ACE must not own host startup policy, provider authority, Lattice
provisioning, or any ACE-managed Lattice path for gates, authority, freshness, or apply that bypasses
the host/provider contracts. MCP configuration may expose read-only compatibility adapters, but it is
not a trust root and cannot make ordinary MCP tools satisfy blocking ASP gates.

---
title: Governance draft
status: draft
normative: true
summary: Private governance, compatibility, conformance, authority, and public-release posture.
updated: 2026-06-22
---

# Governance draft

This document is private draft governance for ASP. It does not approve publication, public standard
claims, package publication, a public registry, a certification program, or stable manifest claims.
Those claims remain blocked until the public-release gate below is explicitly satisfied and approved by
maintainers.

## Spec license

Private placeholder until publication is approved. No public spec license is granted by this draft.
Before publication, maintainers must approve the spec license, package/license alignment, attribution
requirements, and any trademark or naming constraints.

## Contribution and IP policy

Private placeholder until publication is approved. External contributions, if accepted later, need an
approved contribution and IP policy before they can affect normative text, schemas, fixtures, or
conformance suites. That policy must define whether the project uses a DCO, CLA, inbound=outbound
license terms, patent language, security disclosure expectations, and third-party implementation
contribution rules.

## Decision process

Normative changes require maintainer review. Changes that alter protocol vocabulary, schemas,
examples, conformance expectations, or authority semantics must update `index.json` and every affected
spec chapter, schema, fixture, and example in the same change.

Accepted ADRs are append-only decision history. If an accepted decision is reopened or materially
changed, add a superseding ADR instead of rewriting the accepted decision in place.

## Compatibility and versioning policy

ASP compatibility is semantic first: hosts, servers, harnesses, schemas, examples, and conformance
fixtures must preserve the observable obligations around immutable candidate input, provider
assessments, host decisions, edit plans, freshness, authority grants, assurance modes, and mediated
apply.

Private v1.0 changes may still revise draft wire bindings or deployment surfaces. A compatibility
change is material when it changes required behavior, accepted inputs, emitted outputs, failure
classes, authority evidence, assurance reporting, or fixture meaning. Material changes must update the
spec, schemas, examples, and `index.json` together.

## Extension namespace rules

Core ASP method names, schema names, diagnostic sources, and authority evidence fields are reserved for
the protocol. Experimental extension namespaces are private unless a later ADR promotes them.

Third-party, vendor, product, package, registry, or local namespaces can identify ownership or
extension shape, but they cannot imply conformance, trust, registry inclusion, certification, or gate
authority. A namespace can become blocking only through a trusted policy authority grant for a pinned
provider and named requirement at a named call-site.

## Maintainer policy

Maintainers control private draft changes, publication approval, naming, package, registry,
governance, and release-readiness decisions. Maintainer approval for one artifact does not approve
public standard messaging, certification, registry operation, package publication, or stable manifest
claims.

## Open Engine conflict-of-interest separation

The Open Engine may ship reference implementations, but implementation interests must stay separate
from spec decisions. `@the-open-engine/asp` is the planned reference/default conforming host, not the
mandatory centralized ASP host. Other conforming hosts must remain valid.

Opcore is the first reference engine/server implementation. It is not ASP, not the protocol, and not
the host. Opcore output can satisfy a gate only when trusted policy grants pinned authority for the
named requirement and call-site.

## Authority posture

ASP separates five authority and trust evidence axes:

- Identity: who published or owns the provider.
- Integrity: which exact artifact, package, or digest is running.
- Conformance: whether the provider implements ASP behavior correctly.
- Isolation: what the provider can read, write, execute, or transmit.
- Authority: whether trusted policy allows the provider to satisfy a named gate.

Conformance is protocol behavior evidence only. It is not a trust root, certification, registry
inclusion, or gate authority. Certification, registry, signing, provenance labels, and trust-tier
mechanics are deferred unless a later approved issue or ADR promotes them. Certification, if added
later, must never grant blocking authority automatically.

Gate authority requires trusted policy that pins provider identity/version/digest to a named
requirement at a named call-site. Repository config, local overrides, installed manifests, package
scope, first-party labels, publisher provenance, signatures, and certification labels are not trust
roots by themselves and cannot weaken trusted policy.

## Public-release gate

ASP must not be described as a public standard, published standard, stable registry, certification
program, or stable manifest ecosystem until all of the following are true:

- Explicit maintainer approval for publication and public messaging.
- Evidence for at least two conforming hosts.
- Evidence for at least two conforming servers.
- Host and server conformance evidence from the black-box conformance suites.
- Dogfood parity evidence showing ASP can replace predecessor guardrail paths without weakening
  required assurance.
- Naming, package, registry, governance, and release-readiness review are complete.

Until this gate is met, public-standard, package-publish, registry, certification-program, and stable
manifest claims remain private and deferred.

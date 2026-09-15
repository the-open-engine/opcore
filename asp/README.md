# Agent Server Protocol definition

This directory contains the complete ASP `1.0` definition maintained with
Opcore. The definition is data and documentation only. Opcore's Rust
code implements four providers and a private local composer; this tree fixes
the wire contract a conforming decision-maker and its providers share.

ASP keeps one boundary crisp:

```text
agent or harness -> host -> provider
                         <- Assessment
                 <- Decision and receipt
```

Providers assess immutable candidate content. The host owns policy, authority,
freshness, the final decision, receipts, and any apply behavior.

## Start here

- [`spec/11-core-profile.md`](spec/11-core-profile.md) is the smallest check-only
  profile implemented first by Opcore.
- [`spec/`](spec/) contains the complete protocol specification.
- [`schemas/`](schemas/) contains every JSON Schema in the ASP `1.0`
  surface, including optional non-Core capability families.
- [`examples/`](examples/) contains the schema-bound wire examples.
- [`GLOSSARY.md`](GLOSSARY.md) defines normative vocabulary.
- [`docs/conformance/`](docs/conformance/) and
  [`tests/conformance/fixtures/`](tests/conformance/fixtures/) preserve the
  conformance requirements and frozen report fixtures.
- [`decisions/`](decisions/) and [`docs/governance/`](docs/governance/) preserve
  the rationale and governance documents referenced by the specification.

The definition began with the immutable upstream revision recorded in
[`SOURCE.json`](SOURCE.json). Opcore now maintains the v1.0 successor in
this tree. The source record binds both that lineage and the exact current
definition digest. Protocol changes must update the source record and the
implementation/conformance tests in the same review.

## Intentionally not imported

The former repository's TypeScript reference host, manager/daemon, provider
catalog, setup wizard, executable conformance runners, package-manager files,
planning notes, generated evidence, and static website are not part of this
definition bundle. They are implementation or project-history material, not wire
contracts. Some preserved conformance traceability links therefore point back to
the recorded upstream revision for historical implementation evidence.

This bundle is part of Opcore and is covered by the repository's root
[`LICENSE`](../LICENSE). The recorded upstream revision did not contain a
standalone license file.

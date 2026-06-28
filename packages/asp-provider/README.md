# @the-open-engine/opcore-asp-provider

A standalone **ASP Core check provider** facade over Opcore validation.

It runs as a small stdio JSON-RPC process, `opcore-asp-provider --stdio`, that an
ASP host or manager launches. It receives a baseline and a changeset, maps that
changeset into hypothetical validation overlays, runs Opcore's TypeScript and Rust
validation checks against them, and returns provider-owned diagnostics and coverage.

**Providers assess; hosts decide.** This package never makes a policy decision, never
holds authority, never grants a gate, and never applies an edit. It reports findings
and honest coverage; the ASP host owns the allow/deny/transaction outcome.

## What it is (and is not)

- It **is** an ASP Core `check` capability provider over Opcore validation.
- It **is** read-only with respect to the host workspace and the network.
- It is **not** an ASP host, manager, catalog, or authority.
- It is **not** exposed through aggregate CLI ASP subcommands; there is no ASP router
  command. The provider is launched as its own process.
- It does **not** use ACE as a carrier or provisioner, does **not** read or write
  `.ace/runtime`, and does **not** execute `rox`, `crg`, or `cix`.
- It makes no ASP-standard, old-tool-replacement, security-scanner, all-stack,
  AI-authorship, automatic-fix, or opaque score-style claim.

## Install

Package publication is maintainer-controlled during alpha staging. After
publication, install the provider package directly:

```sh
npm install @the-open-engine/opcore-asp-provider
```

This installs the `opcore-asp-provider` bin alongside its Opcore validation
dependencies. The package is launched by an ASP host/manager, not run directly by an
end user. A provisional install manifest is included at
`@the-open-engine/opcore-asp-provider/manifests/opcore-asp-provider.provisional.json`
(see [Provisional manifest](#provisional-manifest)).

## Launch

```sh
opcore-asp-provider --stdio
```

From a built source checkout, launch the same provider entrypoint with:

```sh
node packages/asp-provider/dist/index.js --stdio
```

The process speaks newline-delimited JSON-RPC 2.0 over stdin/stdout. Without
`--stdio` it prints usage and exits non-zero. There is no other entrypoint.

## Protocol

Protocol version: `asp/0.1`. Capability family: `check`.

### Lifecycle

1. `initialize` (request) — the host sends `protocolVersion`, optional host metadata,
   and an optional workspace `baseline`. A mismatched `protocolVersion` is rejected.
   The provider replies with its advertised check capability metadata.
2. `initialized` (notification) — the host confirms the session and sends the
   `grantedPermissions` (read globs only; write/network are not requested).
3. `check/evaluate` (request) — sent after `initialized`; evaluating before the grant
   fails closed. The provider returns an `Assessment`.

`check/evaluate` accepts a `ChangeSet` (`baseline` + `changes[]`), an optional
`changesetDigest`, `comparison` (`all` | `introduced`), `callSite`
(`interactive` | `gate` | `sweep`), an optional `timeoutMs`, and an optional check
selection. Changes are `create`, `modify`, `delete`, or `rename`.

### Host callbacks

The provider owns no file access of its own. All ASP-owned content is read back
through host callbacks:

- `workspace/listTree` — enumerate paths/globs the provider needs.
- `workspace/readBlob` — fetch blob content by id for baseline and changeset
  after-state.

Changeset entries map to validation overlays: `create`/`modify` become write
overlays sourced from the after-blob, `delete` removes the path, and `rename` is
modeled as delete-old plus write-new. The validation file view then exposes the
hypothetical after-state to checks without ever mutating the host workspace.

## Permissions

The provider requests the minimum:

- `read`: workspace blobs needed for the changeset and its baseline (via callbacks).
- `write`: **false** — it never writes the workspace.
- `network`: **false** — it never makes network calls.

It exposes no apply, decision, authority, assurance, transaction, or gate fields.

## Coverage and degraded honesty

Assessments report coverage honestly rather than implying clean exhaustive results:

- TypeScript/JavaScript checks (syntax, type, import-graph, dead-code,
  function-metrics, relevant-tests) are the deep surface.
- Rust checks (source-hygiene, fmt, cargo-check, clippy, rustdoc, import-graph,
  dead-code, unused-deps, file-length, function-metrics) are useful when the
  toolchain is present.
- Missing graph facts, missing toolchains, or unavailable provider surfaces are
  reported as `degraded` or `unsupported` coverage parts with a reason and
  requirement — never as silent gaps or fabricated findings.

Each assessment binds `validAsOf.baseline`, `validAsOf.changesetDigest`, and
`validAsOf.blobs` to the exact host input and read set, so a host can tell precisely
what state the assessment was computed against.

## Provisional manifest

`manifests/opcore-asp-provider.provisional.json` is **install metadata only**. It
records the provider id, package, bin (`opcore-asp-provider --stdio`), capability
family, check ids, read-only permissions, and a `dist/index.js` checksum. It carries
`noAuthority`, `noTrust`, and `noGateGrant`; host policy owns trust and gating
decisions for any consuming workflow. Whether the canonical packaged ASP server
manifest is owned here or converted by the ASP manager is tracked in the Opcore
release-readiness coordination.

## License

MIT.

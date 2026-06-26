# Opcore Agent Guidance

Update this file when changing release architecture, public naming, or repo
conventions.

## Non-Negotiables

- This repository is private until maintainers explicitly approve publication.
- Do not publish packages, push public docs, announce release status, or create
  public-facing claims without explicit approval.
- The public product name is Opcore. Do not introduce legacy product naming into
  release-facing files, package metadata, examples, quickstarts, screenshots, or
  docs in this repository.
- Keep user-facing setup simple: scan first, then optional setup, then changed
  file checks and measurable deltas.
- Opcore must remain independent from ACE. ACE can be one downstream client of
  an ASP host, but it must not ship Opcore, provision providers, or own release
  gates.
- ASP is the host/protocol/manager layer. Opcore is one provider/product behind
  that layer, not the protocol, not the host, and not a privileged provider.

## Public UX Rules

- The first screen must help a developer run Opcore in under 10 minutes.
- Always show what was checked and what was skipped before showing findings.
- Use named signals, counts, and file locations. Do not invent a single opaque
  quality score.
- Unsupported stacks are a coverage state, not a failure and not a hidden pass.
- Source edits are out of scope for the default product loop. Scans and checks
  must be read-only on source.
- `opcore init` may write only explicit setup artifacts after approval, and it
  must be additive, idempotent, and reversible.

## Release Readiness

Before release, verify:

- no release-facing file contains legacy product naming;
- package metadata points at this repository;
- public package names are Opcore names;
- `opcore` scan/check/measure work from installed artifacts, not workspace
  shortcuts;
- native packages are available for supported alpha platforms;
- unsupported platforms and languages degrade honestly;
- claim scrub rejects public-standard, security/SAST, every-stack,
  automatic-fix, and replacement-overclaim wording;
- no public publish step has run.

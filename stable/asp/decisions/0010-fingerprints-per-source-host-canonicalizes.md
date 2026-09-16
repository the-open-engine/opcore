---
adr: 10
title: Fingerprints are per-source; the host canonicalizes for cross-server dedup
status: accepted
date: 2026-06-16
---

# 10. Fingerprints are per-source; the host canonicalizes for cross-server dedup

## Context

Cross-vendor fingerprint comparability was unspecified, yet arbitration dedup, precedence, and
cross-server `introduced` appeared to depend on it (review SI-2, HM-9). Forcing every vendor to
compute identical fingerprints is a heavy, fragile standardization burden.

## Decision

- A `fingerprint` MUST be stable **within one `diagnosticSource`** (across edits and position shifts),
  so `introduced` and same-source dedup are exact.
- A fingerprint is **NOT required to be comparable across servers**.
- Cross-server dedup/grouping is the **host's** job, done best-effort by canonicalizing on
  `source + code + location` (all on-wire fields; there is no separate `anchor` field).
- Cross-server fingerprint equality MUST NOT affect the gate verdict — only within-source results are
  authoritative for gating.

## Consequences

- Implementers (and LSP-wrapper adapters) guarantee only within-their-own-source stability — far
  cheaper, and achievable without a shared algorithm.
- The host owns whatever cross-server grouping it surfaces and can never wrongly clear a gate because
  two vendors happened to disagree on a hash.

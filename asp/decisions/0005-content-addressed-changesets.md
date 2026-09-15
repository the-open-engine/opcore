---
adr: 5
title: Content-addressed changesets from day one
status: accepted
date: 2026-06-16
---

# 5. Content-addressed changesets from day one

## Context

A changeset could be encoded inline (full before/after bytes), as a unified-diff patch, or as
content-addressed blob references the host serves on demand. Inline is simplest but heavy and leaks
the whole tree to every server. We considered shipping inline for v0 and content-addressing later.

## Decision

**Content-addressed from day one.** A changeset is a path → blob-hash overlay on a content-addressed
baseline. Servers pull bytes lazily via `workspace/listTree` + `workspace/readBlob`.

## Consequences

- **Cache by construction:** a blob id *is* its content hash, so warm servers cache across calls and
  sessions and re-fetch only unseen ids.
- **Least-privilege reads are enforced at the byte boundary:** `readBlob` is the permission
  chokepoint — the host serves a blob only if it is referenced (baseline ∪ changeset) and within
  granted read scope. A server physically cannot read outside its grant.
- **Exact freshness:** baseline rev + the set of blob hashes read is the `validAsOf` identity;
  staleness is hash inequality, never mtimes.
- Cost: a `workspace/readBlob` round-trip and a blob store in the host. Accepted — the security and
  caching properties are worth it, and retrofitting content-addressing later would churn every role.

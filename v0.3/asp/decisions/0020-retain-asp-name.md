---
adr: 20
title: Retain the ASP name privately while deferring public naming review
status: accepted
date: 2026-06-22
---

# 20. Retain the ASP name privately while deferring public naming review

## Context

External review flagged that "Agent Server Protocol" has some public prior use. The maintainer
explicitly chose to keep the ASP name for now because the conflicting use is not relevant enough to
block private architecture work.

## Decision

Continue using **Agent Server Protocol (ASP)** for private specification, implementation, and
dogfood work. Do not treat the name as publicly cleared.

## Consequences

- Private docs, issues, and package planning can keep the ASP name.
- Public launch still needs naming, trademark, package, repository, and domain diligence.
- Name retention does not justify public "open standard" messaging before conformance evidence exists.

---
name: rust-engineer
description: Canonical Rust implementation skill for writing, reviewing, refactoring, and debugging idiomatic Rust. Use when building Rust crates or binaries, shaping APIs around ownership and traits, implementing Tokio async code, choosing error handling, tightening tests/lints/docs, or optimizing for correctness and performance.
license: MIT
metadata:
  author: https://github.com/Jeffallan
  version: "1.2.0"
  domain: language
  triggers: Rust, Cargo, ownership, borrowing, lifetimes, async Rust, tokio, zero-cost abstractions, memory safety, systems programming
  role: specialist
  scope: implementation
  output-format: code
  related-skills: test-master
---

# Rust Engineer

Primary Rust skill for agentic coding. Keep this file lean; load only the references needed for the task instead of reading the whole skill tree.

## Use This Skill For

- New Rust implementation work
- Refactors that affect ownership, traits, or async boundaries
- Debugging borrow checker, lifetime, Send/Sync, or error-handling issues
- Code review of Rust correctness, API shape, and performance risks
- Tightening tests, lint discipline, or public API documentation

## Core Workflow

1. **Shape the API first** — Choose borrowed vs owned inputs, error types, trait boundaries, and sync vs async semantics before writing bodies.
2. **Load only relevant references** — Pull in ownership, traits, async, testing, linting, performance, or docs guidance as needed.
3. **Implement idiomatically** — Prefer borrowing over cloning, static dispatch over dynamic dispatch unless heterogeneity is required, and explicit invariants over comments that restate code.
4. **Make failure legible** — Use `Result`/`Option`, typed library errors with `thiserror`, and `anyhow` only at application boundaries.
5. **Prove behavior at the right layer** — Unit test function logic, integration test crate boundaries, doctest public APIs, and benchmark only after a measurable concern exists.
6. **Finish with the mechanical pass** — Run formatting, clippy, and tests; either fix warnings or justify the narrow exception inline.

## Default Load Order

Start with the smallest relevant set:

- `references/ownership.md` for API shape, borrowing, lifetimes, smart pointers, and `Send`/`Sync`
- `references/error-handling.md` for `Result`, `Option`, `thiserror`, `anyhow`, and context
- `references/testing.md` for unit/integration/doctest/property/snapshot strategy

Add these only when needed:

- `references/traits.md` for trait design, bounds, associated types, dispatch, and conversion traits
- `references/async.md` for Tokio, concurrency, cancellation, channels, streams, and async pitfalls
- `references/linting.md` for clippy discipline and suppression rules
- `references/performance.md` for measuring first, clone pressure, allocation shape, and dispatch costs
- `references/documentation.md` for doc comments, `SAFETY:` comments, and maintainer-facing rationale

## Quick Rules

- Prefer `&str`, `&Path`, `&[T]`, and `&T` for read-only inputs. Accept owned values only when the function must store, transform, or transfer ownership.
- Avoid `&String` and `&Vec<T>` in public APIs unless the function truly depends on those concrete container types.
- Prefer `thiserror` for library or reusable crate errors; use `anyhow` at binaries, CLI entrypoints, and orchestration layers.
- Avoid `unwrap()` and `expect()` in production paths. Use them in tests or when failure is genuinely impossible and the invariant is documented.
- Use generics and static dispatch by default; use `dyn Trait` at deliberate runtime boundaries or for heterogeneous collections.
- Prefer explicit types and invariants over comments. Comments should explain **why**, not restate **what**.
- Optimize only after measurement. Redundant cloning, needless allocation, and accidental dynamic dispatch are common real problems; speculative micro-optimizations are not.

## Validation Commands

```bash
cargo fmt --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
cargo test --doc --locked
```

Use narrower commands when the workspace or task requires it, but treat these as the default finish line.

## Output Expectations

When implementing or reviewing Rust code, prefer answers that include:

1. API shape decisions: borrowing, ownership, trait bounds, and error type choices
2. Implementation that is idiomatic and explicit about invariants
3. Tests or verification at the owning layer
4. Short notes on tradeoffs only where they matter

## Knowledge Reference

Rust 2021+, Cargo, ownership/borrowing, lifetimes, traits, generics, async/await, tokio, `Result`/`Option`, `thiserror`/`anyhow`, clippy, rustfmt, doctests, property testing, criterion, Miri, unsafe Rust

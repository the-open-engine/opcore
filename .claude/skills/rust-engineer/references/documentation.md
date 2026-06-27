# Documentation and Comments

Use comments and docs to preserve intent, not to narrate syntax.

## Public APIs

Use `///` doc comments for public items:

- what the API does
- important invariants
- error conditions
- panic conditions, if any
- examples worth turning into doctests

## Inline Comments

Use `//` comments for:

- non-obvious design choices
- workarounds with a real reason
- concurrency or memory-ordering rationale
- safety invariants before `unsafe`

Bad comments restate code. Good comments explain why the code has this shape.

## `SAFETY:` Comments

Every `unsafe` block should have a nearby `SAFETY:` comment stating the invariant that makes the block sound.

```rust
// SAFETY: `ptr` came from `Vec::as_mut_ptr`, `len` elements are initialized,
// and `dst` does not overlap `src`.
unsafe {
    std::ptr::copy_nonoverlapping(src, dst, len);
}
```

## TODOs

TODOs should be actionable and traceable. Prefer a linked issue or enough context that another maintainer can finish the work later.

## Review Checklist

- Does the doc comment explain contract, errors, and examples for the public API?
- Does the inline comment explain why, not what?
- Does every `unsafe` block have a `SAFETY:` explanation?
- Should this example become a doctest?

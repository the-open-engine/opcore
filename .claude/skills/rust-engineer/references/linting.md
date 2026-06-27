# Linting and Mechanical Discipline

Linting is not cosmetic in Rust. It catches real API-shape problems, accidental allocation, style drift, and bug-prone patterns.

## Default Command

```bash
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
```

Use narrower scope only when the workspace genuinely requires it.

## What to Fix First

- `redundant_clone`
- `needless_collect`
- `large_enum_variant`
- `map_err_ignore`
- `await_holding_lock`
- `unused_async`
- conversion and allocation warnings that reveal a bad boundary

The point is not to satisfy clippy mechanically. The point is to fix the underlying shape that caused the warning.

## Suppressions

Default to fixing the code. If a lint is a false positive or the tradeoff is intentional:

- scope the suppression as narrowly as possible
- document the reason inline
- prefer `#[expect(...)]` when supported by the project toolchain

Never silence a warning just to get the build green.

## Review Checklist

- Did clippy expose a deeper ownership or allocation problem?
- Is a warning caused by an overly concrete API like `&String` or `Vec<T>` parameters?
- Is an async warning really pointing to a blocking or lock-lifetime bug?
- Is a suppression local, justified, and stable?

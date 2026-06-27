# Testing in Rust

Tests should attack the contract, not mirror the implementation.

## Test Selection

- Unit tests: function-level behavior and edge cases
- Integration tests: crate boundaries, public workflows, CLI behavior, serialization, persistence
- Doctests: public API usage examples
- Property tests: invariants across many inputs
- Snapshot tests: stable generated output
- Benchmarks: performance questions only after correctness is established

## Naming and Scope

Prefer names that state behavior and condition:

```rust
#[test]
fn parse_port_returns_error_when_value_is_out_of_range() {}
```

Target one behavior per test. Multiple assertions are fine when they all prove the same behavior; avoid giant “kitchen sink” tests.

Organize tests around the unit of work:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    mod parse_port {
        use super::*;

        #[test]
        fn returns_error_when_input_is_empty() {
            assert!(parse_port("").is_err());
        }
    }
}
```

## Unit Tests

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_replaces_tabs() {
        assert_eq!(normalize("a\tb"), "a b");
    }

    #[test]
    fn normalize_borrows_when_no_change_is_needed() {
        assert!(matches!(normalize("ab"), std::borrow::Cow::Borrowed("ab")));
    }
}
```

## Doctests

Use doctests for public APIs that users are likely to copy.

```rust
/// Parses a TCP port from text.
///
/// ```
/// let port = mylib::parse_port("8080").unwrap();
/// assert_eq!(port, 8080);
/// ```
pub fn parse_port(raw: &str) -> Result<u16, std::num::ParseIntError> {
    raw.parse()
}
```

## Integration Tests

Put cross-module or public workflow tests in `tests/`.

```rust
// tests/cli.rs
#[test]
fn config_command_reads_file_from_disk() {
    // exercise the public boundary, not internal helpers
}
```

Use shared helpers sparingly. If every test needs a complex harness, the production boundary may be too hard to drive.

## Async Tests

```rust
#[tokio::test]
async fn fetch_user_times_out_when_backend_hangs() {
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(50),
        fetch_user("42"),
    )
    .await;

    assert!(result.is_err());
}
```

Test cancellation, timeout, and task-join behavior explicitly when they are part of the contract.

## Property Tests

Use `proptest` or similar for invariants:

- parsing/formatting round trips
- order preservation
- idempotence
- commutativity or associativity

## Snapshot Tests

Use snapshot tests for generated text, structured output, or diagnostics where diff quality matters more than hand-written assertions.

- Keep snapshots small and intentional
- Review every snapshot change as if it were code
- Do not use snapshots to hide behavior you do not understand

## Fixtures and Cleanup

Prefer helpers that clean up automatically with `Drop`, tempdirs, or test transactions. Avoid global mutable state unless the test runner forces it.

## Review Checklist

- Does the test fail for the bug you care about, not just for any bug?
- Is the test exercising the owning layer of the behavior?
- Is the name specific about behavior and condition?
- Would a simpler assertion prove the same claim?
- Should this be a doctest, integration test, property test, or snapshot instead?

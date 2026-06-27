# Error Handling in Rust

Model failure explicitly. Good Rust error handling makes call sites simpler, not noisier.

## Choose the Right Error Surface

- `Option<T>`: absence is expected and uninteresting
- `Result<T, E>`: the caller should know why the operation failed
- `panic!`: unrecoverable bug or violated invariant, not normal control flow

```rust
fn find_user(id: u64) -> Option<User> {
    USERS.get(&id).cloned()
}

fn parse_port(raw: &str) -> Result<u16, std::num::ParseIntError> {
    raw.parse()
}
```

## Use `thiserror` for Libraries and Reusable Modules

Use typed errors when the caller may branch on failure kinds, log them structurally, or expose them across crate boundaries.

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("failed to read config from {path}")]
    Read {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid port `{raw}`")]
    InvalidPort {
        raw: String,
        #[source]
        source: std::num::ParseIntError,
    },
}

fn load_port(path: &str) -> Result<u16, ConfigError> {
    let raw = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
        path: path.to_owned(),
        source,
    })?;

    raw.trim().parse().map_err(|source| ConfigError::InvalidPort {
        raw,
        source,
    })
}
```

## Use `anyhow` at Application Boundaries

`anyhow` is good for binaries, CLIs, jobs, and orchestration layers that mostly need context-rich propagation rather than a public error enum.

```rust
use anyhow::{Context, Result, ensure};

fn run(path: &str) -> Result<()> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read config at {path}"))?;

    ensure!(!raw.trim().is_empty(), "config file is empty");
    Ok(())
}
```

## Prefer `?` Plus Context Over Manual Match Chains

```rust
use anyhow::{Context, Result};

fn read_user_id(path: &str) -> Result<u64> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading {path}"))?;
    let id = raw.trim().parse().context("parsing user id")?;
    Ok(id)
}
```

Add context where it helps the next debugging step. Do not restate what the underlying error already says.

## Conversions

Use `#[from]` or explicit `map_err` conversions instead of `Box<dyn Error>` unless you truly need heterogeneous dynamic errors at a boundary.

## `unwrap()` and `expect()`

Default rule:

- Avoid both in production logic.
- Use them in tests, examples, and setup code when failure should abort the test immediately.
- Use `expect()` in production only for an invariant that is genuinely impossible in correct code, and make the message explain the invariant.

That is an exception, not the design default.

## Async Error Boundaries

In async code, separate these failure classes:

- task join failure
- timeout or cancellation
- domain failure inside the task

Do not collapse them into one vague string if the caller can recover differently.

## Review Checklist

- Should this be `Option` or `Result`?
- Does the error type match the boundary: typed for libraries, `anyhow` for apps?
- Is context attached where it helps locate the failure?
- Are panics limited to bugs, tests, or impossible invariants?
- Would a caller need to branch on this error later? If yes, avoid erasing it too early.

# Performance Mindset

Measure first. Rust often makes it easy to write fast code, but it also makes it easy to cargo-cult “optimizations” that add complexity with no user-visible win.

## Baseline Rules

- Benchmark and profile with release builds
- Fix obvious allocation pressure before reaching for unsafe or complex abstractions
- Prefer data-shape fixes over micro-optimizations

## Common Real Problems

### Redundant Cloning

Look for:

- cloning in loops
- cloning just to satisfy an avoidable ownership boundary
- cloning large maps or vectors instead of borrowing, slicing, or using `Cow`

### Needless Allocation

Look for:

- `format!` where borrowed formatting or `write!` would do
- `collect::<Vec<_>>()` followed immediately by iteration
- `String` or `Vec<T>` parameters where a borrowed view would work

### Dispatch Costs

Prefer static dispatch in hot paths. Use `dyn Trait` when heterogeneity, plugin-style boundaries, or reduced code size is the point.

### Data Layout

Large enums, oversized structs, and pointer-heavy graphs can matter more than a clever loop rewrite.

## Tooling

- `cargo bench`
- `criterion`
- `cargo flamegraph` or platform-appropriate profilers
- `cargo clippy -- -D clippy::perf`

## Review Checklist

- Was the performance problem measured?
- Is cloning or allocation happening because of a bad API boundary?
- Would a borrowed input or iterator pipeline remove the cost entirely?
- Is dynamic dispatch present for a real design reason?
- Is the optimization making invariants harder to maintain than the win justifies?

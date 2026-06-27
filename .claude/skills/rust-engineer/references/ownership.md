# Ownership, Borrowing, and API Shape

Choose the smallest, most flexible type that matches the contract. Most Rust API quality problems start here.

## Prefer Borrowed Inputs for Read-Only Data

Use the borrowed view type, not the owned container type, when the function only reads data:

| Need | Prefer | Avoid |
| --- | --- | --- |
| text | `&str` | `&String` |
| bytes | `&[u8]` | `&Vec<u8>` |
| slice-like data | `&[T]` | `&Vec<T>` |
| filesystem paths | `&Path` | `&PathBuf` |

```rust
use std::path::Path;

fn parse_name(input: &str) -> usize {
    input.trim().len()
}

fn checksum(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0, |acc, b| acc + u32::from(*b))
}

fn open_config(path: &Path) -> std::io::Result<String> {
    std::fs::read_to_string(path)
}
```

Take ownership only when the function must store the value, mutate and return it, move it into a task, or otherwise outlive the caller's borrow.

## Borrowing Beats Cloning

Clone because ownership is required, not because lifetimes feel inconvenient.

```rust
fn count_non_zero(data: &[u8]) -> usize {
    data.iter().filter(|&&byte| byte != 0).count()
}

fn spawn_job(name: String) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        println!("running {name}");
    })
}
```

If ownership is conditional, use `Cow<'_, T>` rather than eagerly allocating.

```rust
use std::borrow::Cow;

fn normalize(input: &str) -> Cow<'_, str> {
    if input.contains('\t') {
        Cow::Owned(input.replace('\t', " "))
    } else {
        Cow::Borrowed(input)
    }
}
```

## Lifetimes

Write explicit lifetimes when the relationship matters to the reader or the compiler.

```rust
fn longest<'a>(left: &'a str, right: &'a str) -> &'a str {
    if left.len() >= right.len() { left } else { right }
}

struct Excerpt<'a> {
    part: &'a str,
}
```

Do not add explicit lifetimes just because the code is generic. Add them when they describe a real borrowing relationship.

## Smart Pointer Selection

- `Box<T>`: single owner, heap allocation
- `Rc<T>`: shared ownership on one thread
- `Arc<T>`: shared ownership across threads
- `RefCell<T>`: interior mutability with runtime borrow checks on one thread
- `Mutex<T>` / `RwLock<T>`: synchronized interior mutability across threads

Combine pointers only when the ownership model truly requires it. `Rc<RefCell<T>>` and `Arc<Mutex<T>>` are legitimate tools, but they are also a signal that mutation and sharing are both central to the design.

## `Send` and `Sync`

Use these rules when debugging thread-boundary failures:

- `T: Send` means ownership of `T` can move to another thread
- `T: Sync` means `&T` can be shared across threads
- `&mut T` is exclusive access, so it is not `Sync`
- `Rc<T>` is neither `Send` nor `Sync`
- `Arc<T>` is `Send`/`Sync` only if `T` is `Send`/`Sync`

When a spawned Tokio task fails trait bounds, inspect the captured values first. One non-`Send` capture is usually the real cause.

## Interior Mutability

Use interior mutability for a reason:

- `Cell<T>` for tiny `Copy` values
- `RefCell<T>` for single-threaded mutation hidden behind an immutable API
- `Mutex<T>` / `RwLock<T>` for cross-thread shared mutation

Keep lock lifetimes short, and never hold a lock across `.await` unless the design explicitly requires an async-aware lock and the critical section is intentional.

## Pin

Most code should not mention `Pin`. Reach for it when implementing lower-level async, self-referential, or intrusive structures where movement after initialization would be unsound.

Document every `unsafe` block that interacts with pinning using a `SAFETY:` comment that states the invariant.

## Practical Review Checklist

- Could this argument be `&str`, `&[T]`, or `&Path` instead of `&String`, `&Vec<T>`, or `&PathBuf`?
- Is a clone required by ownership, or just masking an avoidable borrow/lifetime issue?
- Is shared mutable state necessary, or would message passing or plain borrowing be simpler?
- Are `Send`/`Sync` requirements explicit at thread or task boundaries?
- Is `Pin` solving a real immovability problem, not just appearing because async code exists?

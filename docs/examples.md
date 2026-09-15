# Examples

[Overview](../README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md)

Use these examples in a disposable Git project, as described in Getting started. Run `opcore check --repo . --all` for Fast Verify examples. Sense examples compare the described baseline with the source change. Native examples also need the project and tool setup in the provider guide.

Fast Verify and Project Sense text below was checked against the current binary. Native diagnostics include stable Opcore rule IDs, but compiler wording can change with the installed toolchain.

<details>
<summary>Fast Verify · TypeScript function with too many parameters</summary>

```ts
export function total(a: number, b: number, c: number, d: number, e: number, f: number) {
  return a + b + c + d + e + f;
}
```

`complexity.max-parameters`: `function parameters: 6; configured maximum is 5`

</details>

<details>
<summary>Fast Verify · JavaScript decision logic crosses the complexity limit</summary>

```js
const allowed = flags =>
  flags[0] && flags[1] && flags[2] && flags[3] && flags[4] && flags[5] &&
  flags[6] && flags[7] && flags[8] && flags[9] && flags[10];
```

`complexity.max-cyclomatic-complexity`: `cyclomatic complexity: 11; configured maximum is 10`

</details>

<details>
<summary>Fast Verify · Python function with too many parameters</summary>

```python
def total(a, b, c, d, e, f):
    return a + b + c + d + e + f
```

`complexity.max-parameters`: `function has 6 parameters; configured maximum is 5`

</details>

<details>
<summary>Fast Verify · Rust function with too many parameters</summary>

```rust
fn total(a: u8, b: u8, c: u8, d: u8, e: u8, f: u8) -> u8 {
    a + b + c + d + e + f
}
```

`complexity.max-parameters`: `Rust callable has 6 parameters; configured maximum is 5`

</details>

<details>
<summary>Fast Verify · Go function with too many parameters</summary>

```go
package metrics

func total(a int, b int, c int, d int, e int, f int) int {
    return a + b + c + d + e + f
}
```

`complexity.max-parameters`: `Go callable has 6 function parameters; configured maximum is 5`

</details>

<details>
<summary>Fast Verify · Terraform JSON with the wrong document shape</summary>

```json
42
```

For `main.tf.json`, Verify reports `hcl.syntax`: `IaC JSON syntax requires an object at the document root`.

</details>

<details>
<summary>Fast Verify · Shell block missing its closing fi</summary>

```sh
if true; then
  echo ok
```

`shell.syntax`: `Invalid Shell syntax: expected 'fi'`

</details>

<details>
<summary>Fast Verify · Protocol Buffer message missing its closing brace</summary>

```proto
syntax = "proto3";
message Greeting {
```

`protobuf.syntax`: `Invalid Protobuf syntax near }`

</details>

<details>
<summary>Project Sense · A change introduces a TypeScript runtime cycle</summary>

`src/a.ts` already imports `src/b.ts`. This new import in `src/b.ts` closes the loop:

```ts
import { a } from "./a";
export const b = a + 1;
```

Rule: `sense.runtime_cycle`

```text
cycle: src/b.ts -> src/a.ts (2 files)
  witness: src/b.ts -> src/a.ts -> src/b.ts
```

JSON evidence identifies the introduced trigger as `{"from":"src/b.ts","to":"src/a.ts","kind":"runtime"}`.

</details>

<details>
<summary>Project Sense · A copied file introduces exact duplication</summary>

Suppose `src/a.ts` is a 667-byte module already in the baseline. Adding byte-for-byte identical content as `src/b.ts` produces:

`sense.duplication.identical_file`: `duplicate identical file: src/b.ts (2 occurrences, was 1)`

The report lists `src/b.ts` as changed and `src/a.ts` as the existing occurrence. The default minimum is 256 bytes, so a tiny shared snippet does not trigger this rule.

</details>

<details>
<summary>Project Sense · A TypeScript module grows past its public-interface limit</summary>

Suppose `src/api.ts` already has 20 explicit exports. Adding one more crosses the default boundary:

```ts
export const twentyFirstValue = 21;
```

`sense.interface.module_exports` records `before: 20`, `after: 21`, and `limit: 20`. Unchanged or reduced interface debt does not block. Any increase above the limit does, including a change from 21 to 22 exports.

</details>

<details>
<summary>Project Sense · An important module changes without its registered documentation</summary>

Suppose ten modules import `src/core.ts`, and `.opcore.json` binds that source to `docs/core.md` through `documentation.bindings`. Renaming a public export without updating the document produces:

`sense.documentation.document_not_updated`: `update the registered document with this source change`

Opcore reads only the exact source-to-document binding. It does not guess ownership from filenames or search Markdown for matching words.

</details>

<details>
<summary>Rust-native · A return value has the wrong type</summary>

```rust
fn count() -> u32 {
    "one"
}
```

Opcore rule: `opcore-rust-native/cargo-check`. A typical rustc finding is `E0308: mismatched types`; spans and added help come from the installed Rust toolchain.

</details>

<details>
<summary>Node-native · A number is assigned to a string</summary>

```ts
const label: string = 42;
```

Opcore rule: `opcore-node-native/typescript-check/TS2322`. A common TypeScript message is `Type 'number' is not assignable to type 'string'.`; exact text belongs to the installed project-local `tsc`.

</details>

<details>
<summary>Python-native · A number is assigned to a string</summary>

```python
value: str = 1
```

With Pyright, the rule is `opcore-python-native/type-check/reportAssignmentType`; the parser test form is `number is not assignable to str`. With mypy fallback, the rule is `opcore-python-native/type-check/assignment`, commonly with `Incompatible types`. Exact wording belongs to the selected checker version.

</details>

Run `opcore rules` to see every built-in rule and its default policy field.

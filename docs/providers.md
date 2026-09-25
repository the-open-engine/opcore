# Provider setup and usage

[Overview](../README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md)

## Start with the default checks

```sh
opcore check --repo . --all
opcore sense --repo .
```

Default Check uses Fast Verify's built-in parsers and rules. Sense adds repository relationships. Neither command requires a language toolchain or executes repository code. Both read the shared repository and workflow settings in [Configuration](configuration.md).

Fast Verify covers syntax and hygiene across all supported language families, with callable metrics for JavaScript/TypeScript, Python, Rust, and Go. Type errors and project-specific compiler rules need the corresponding native provider.

## Select a native provider

Native tools can execute repository-controlled build scripts, procedural macros, wrappers, and checker plugins with the current account's access to host files and the network. Use the bundled runner only for repositories you trust. `--allow-unsandboxed-native` records consent; it doesn't isolate execution. Authoritative or automatic native checks require an external host that enforces a sandbox. Installed hooks never select native providers.

For ongoing use, add applicable native providers to `workflows.pre-commit.native` and `workflows.ci.native`, then run those workflows from Git hooks and CI. Configured native checks are required; missing tools or dependencies fail the workflow. See the [adoption recipe](getting-started.md#add-pre-commit-and-ci-checks).

Use a comma-separated provider list to combine Fast Verify with a native checker:

```sh
opcore check --repo . \
  --providers fast,rust-native \
  --allow-unsandboxed-native
```

`--providers all` selects all applicable bundled profiles. An explicitly named provider that doesn't apply reports unsupported coverage; the convenience `all` set skips inapplicable profiles. The default comparison reports introduced findings. Add `--comparison all` to inspect current-tree diagnostics, or `--staged` to use the Git index.

Provider-backed checks use the same resolved `.opcore.json` settings as local checks. `--workflow <name>` selects overrides; the host sends effective Fast thresholds through ASP and records each provider's configuration identity. Native compiler settings continue to come from the selected project's own files. Use `--all` for all current diagnostics, `--staged --all` for the full index, or `--tree <target> --base <base>` for committed comparison. Consult `opcore check --help` for source-selection combinations.

### Rust-native

Have Cargo and rustc available on `PATH`, with the project's dependencies already in Cargo's cache. The selected project must contain `Cargo.toml`; root runs check the workspace, and a focused Cargo package retains its surrounding workspace context. An absolute `OPCORE_CARGO` can select a particular Cargo executable.

The provider runs fixed Cargo Check commands with all targets, offline mode, and a fresh output directory. It uses `--locked` when the captured context has a root lockfile. Missing cached dependencies or build inputs produce unavailable or incomplete coverage. For introduced comparison, compiler errors in the baseline can prevent a complete comparison; `--comparison all` requests current diagnostics without that subtraction.

### Node-native

The project needs `package.json`, an npm lockfile, and `tsconfig.json` or `tsconfig.*.json`. Install TypeScript as a project dependency and have npm and Node.js on `PATH`. An absolute `OPCORE_NPM` can select npm.

```sh
opcore check --repo . \
  --providers fast,node-native \
  --allow-unsandboxed-native
```

Populate npm's dependency cache with the project's normal dependency-install workflow before using this profile. Opcore runs offline `npm ci` with lifecycle scripts disabled in its temporary project copy, then invokes only the installed project-local TypeScript compiler. Missing offline dependencies or TypeScript make coverage unavailable; an existing worktree `node_modules` directory doesn't replace the cache requirement. Tracked `node_modules` isn't supported.

The TypeScript projects define the files the compiler checks, including JavaScript when their settings admit it. Fast Verify handles source outside those projects. pnpm/yarn-only locks, package scripts, ESLint, and arbitrary compiler commands are outside this provider.

### Python-native

Install Pyright or mypy on the host and prepare the project's Python environment using its normal workflow. Opcore prefers Pyright and falls back to mypy. It finds them on `PATH` or through absolute `OPCORE_PYRIGHT` and `OPCORE_MYPY` overrides.

```sh
opcore check --repo . \
  --providers fast,python-native \
  --allow-unsandboxed-native
```

The runner selects an interpreter in this order: explicit `OPCORE_PYTHON`, a `.venv` under the project context, an active `VIRTUAL_ENV` contained in that context, then ambient `python3` or `python`. For an environment elsewhere, name its interpreter explicitly:

```sh
OPCORE_PYTHON=/absolute/path/to/venv/bin/python \
  opcore check --repo . \
  --providers python-native \
  --allow-unsandboxed-native
```

Opcore passes every selected `.py` or `.pyi` path and the interpreter to the checker; it doesn't create or synchronize environments. Unresolved imports under an ambient interpreter produce incomplete coverage because the project environment is uncertain. With an explicitly selected or project-contained environment, those diagnostics remain findings for that environment.

## Work in a monorepo

`--roots` selects non-overlapping focus directories while retaining the context each provider needs:

```sh
opcore check --repo . \
  --providers all \
  --roots packages/api,services/worker \
  --allow-unsandboxed-native
```

Fast uses the selected source focus. Node and Python keep the nearest applicable ancestor configuration; Rust keeps repository context while selecting the focused Cargo package. Each run reports its focus and context, with elapsed time and repository-relative findings.

Put shared roots under `providers.<name>.roots` in `.opcore.json`, and override them per workflow when needed. Arrays replace inherited roots; explicit `--roots` replaces configured roots. For example, CI can check all packages while pre-commit selects the packages a team maintains. Whole excluded native roots appear as skipped; excluding every root leaves an indeterminate result. An exclusion affecting inputs within a selected native focus fails before execution with instructions to select project roots or configure the compiler. Context outside that focus remains available when required. Exclusions never suppress a failing compiler diagnostic.

`doctor --workflow <name>` inspects the selected native prerequisites without running checks. A tool on `PATH` doesn't prove its dependencies or project configuration are ready. If a provider fails, inspect its coverage reason; malformed output, timeouts, and incomplete compiler coverage never count as a clean result.

For ASP integration, the executable exposes each profile as a separate provider identity through `serve --stdio --profile <profile>`. Generate the command and public Rust API reference with `./scripts/build-docs.sh` from a checkout; the [protocol definition](../asp/README.md) specifies the callback and assessment contracts.

## Experimental AST-grep provider

Source checkouts include an experimental AST-grep ASP provider under `contrib/asp-ast-grep/`. It accepts bounded declarative Python rules through ASP `check/evaluate.configuration`, including rules supplied from a repository's `.opcore.json`. It is not selectable by `opcore check --providers`; composing it with Opcore currently requires an external ASP host that owns enrollment, validation, and decisions. Opcore rejects a workflow selecting an external provider rather than silently omitting it.

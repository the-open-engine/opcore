//! Provider identities and their source-generated reference.

pub const PROTOCOL_VERSION: &str = "asp/1.0";
pub const CAPABILITY_VERSION: &str = "check/1.0";
pub const PROVIDER_ID: &str = "opcore";
pub const PROVIDER_NAME: &str = "Opcore";
pub const CORE_RULE: &str = "opcore/core";
pub const MANIFEST_VERSION: &str = "asp-server/1.0";
pub const CAPABILITY_PROFILE: &str = "opcore/fast";
pub const RUST_NATIVE_PROVIDER_ID: &str = "opcore-rust-native";
pub const RUST_NATIVE_PROVIDER_NAME: &str = "Opcore Rust Native";
pub const RUST_NATIVE_RULE: &str = "opcore-rust-native/cargo-check";
pub const RUST_NATIVE_CAPABILITY_PROFILE: &str = "opcore/rust-native";
pub const NODE_NATIVE_PROVIDER_ID: &str = "opcore-node-native";
pub const NODE_NATIVE_PROVIDER_NAME: &str = "Opcore Node Native";
pub const NODE_NATIVE_RULE: &str = "opcore-node-native/typescript-check";
pub const NODE_NATIVE_CAPABILITY_PROFILE: &str = "opcore/node-native";
pub const PYTHON_NATIVE_PROVIDER_ID: &str = "opcore-python-native";
pub const PYTHON_NATIVE_PROVIDER_NAME: &str = "Opcore Python Native";
pub const PYTHON_NATIVE_RULE: &str = "opcore-python-native/type-check";
pub const PYTHON_NATIVE_CAPABILITY_PROFILE: &str = "opcore/python-native";

/// Reference for all four ASP provider identities in the Opcore executable.
///
/// Select a profile with `serve --stdio --profile <name>`, or request one through
/// `check --providers <name>`. Each profile has its own process identity and installed
/// manifest. All implement `check/1.0`, support `introduced` and `all` comparisons,
/// and return assessments rather than host decisions or apply instructions.
///
/// The default is [`Fast`](Self::Fast). Native profiles are opt-in: the local Check runner
/// requires `--allow-unsandboxed-native`. An immutable input snapshot and private scratch
/// detect changes but do not isolate executed code from host files, secrets, or the network.
/// Authoritative or automatic native use requires an external OS sandbox.
///
/// No profile installs itself as a repository hook or applies fixes. Providers do not
/// intentionally target the candidate checkout; native code may write host-accessible paths.
/// Missing tools, refused callbacks, stale inputs, and truncated coverage never produce a
/// clean assessment. Native profiles accept workspace scope; Fast also accepts changesets.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, clap::ValueEnum)]
pub enum ProviderProfile {
    /// Fast Verify: built-in parsing and deterministic source checks.
    ///
    /// **Identity:** `opcore`; **CLI name:** `fast` (the default).
    ///
    /// Covers syntax and source hygiene for JavaScript/TypeScript, Python, Rust, Go,
    /// HCL-based infrastructure code, Shell, and Protocol Buffers. Node, Python, Rust,
    /// and Go also receive callable size, parameter, nesting, and complexity checks.
    /// No repository code, project configuration, compiler, or plugin is executed.
    /// Git is required for local CLI capture; direct ASP use obtains bytes from host callbacks.
    ///
    /// ```text
    /// opcore check --repo . --all
    /// opcore serve --stdio --profile fast
    /// ```
    ///
    /// Supports both `changeset` and `workspace` scopes. An empty local changed selection
    /// reports `not_checked`; a selected view without supported source remains unsupported.
    #[default]
    Fast,
    /// Rust-native: fixed Cargo Check over the captured Cargo workspace.
    ///
    /// **Identity:** `opcore-rust-native`; **CLI name:** `rust-native`.
    /// Requires host Cargo, rustc, and already available offline dependencies. Set
    /// `OPCORE_CARGO` to an absolute executable path to override Cargo selection.
    /// A repository-root request runs `cargo check --workspace --all-targets --message-format=json`;
    /// a focused package omits `--workspace`. A captured root lockfile adds `--locked`.
    ///
    /// ```text
    /// opcore check --providers rust-native --allow-unsandboxed-native
    /// opcore check --providers rust-native --roots crates/example --allow-unsandboxed-native
    /// opcore serve --stdio --profile rust-native
    /// ```
    ///
    /// Captures a bounded repository-wide Cargo input envelope, including workspace/path
    /// dependencies and ordinary textual compile resources. Missing required inputs remain
    /// incomplete rather than expanding capture dynamically. Cargo must emit a successful
    /// structured `build-finished` message; a failed baseline cannot prove introduced-only coverage.
    /// Build scripts, proc macros, compiler wrappers, and dependencies may execute with host access.
    /// Offline mode does not enforce network isolation, and Cargo/Rustup homes may be written.
    RustNative,
    /// Node-native: locked, offline TypeScript checking with the project's compiler.
    ///
    /// **Identity:** `opcore-node-native`; **CLI name:** `node-native`.
    /// Requires host Node/npm, a root `package.json`, an npm lockfile, exact `tsconfig.json`
    /// or `tsconfig.*.json` projects, and dependencies already present in the npm cache.
    /// Set `OPCORE_NPM` to an absolute executable path to override npm selection.
    ///
    /// ```text
    /// opcore check --providers node-native --allow-unsandboxed-native
    /// opcore check --providers node-native --roots src --allow-unsandboxed-native
    /// opcore serve --stdio --profile node-native
    /// ```
    ///
    /// Runs fixed offline `npm ci` with lifecycle scripts, audit, funding, and update checks
    /// disabled, then project-local `tsc --project <config> --noEmit --pretty false --listFiles
    /// --incremental false`. The compiler's combined file lists define the checked universe;
    /// JavaScript/TypeScript outside every configured project remains Fast Verify territory.
    /// Focused requests retain the nearest applicable ancestor project configuration.
    /// Missing offline dependencies or `tsc` are unavailable coverage. Generated dependency
    /// trees are removed before scratch verification; npm may read and write its inherited cache.
    NodeNative,
    /// Python-native: host Pyright, with host mypy as the fallback.
    ///
    /// **Identity:** `opcore-python-native`; **CLI name:** `python-native`.
    /// Requires an installed checker and a Python environment containing the project's dependencies.
    /// `OPCORE_PYRIGHT` and `OPCORE_MYPY` select absolute checker executable paths.
    /// The local runner chooses `OPCORE_PYTHON`, the nearest project-context `.venv`,
    /// a project-contained active `VIRTUAL_ENV`, then the ambient PATH interpreter, in that order.
    /// Direct ASP use records an ambient interpreter unless the host selects one explicitly.
    ///
    /// ```text
    /// opcore check --providers python-native --allow-unsandboxed-native
    /// opcore check --providers python-native --roots src --allow-unsandboxed-native
    /// opcore serve --stdio --profile python-native
    /// ```
    ///
    /// Passes every selected `.py`/`.pyi` path to Pyright with `--outputjson --warnings --threads 1
    /// --pythonpath <interpreter>`, or to mypy with fixed flags, the selected interpreter, and an
    /// ephemeral cache. Pyright's analyzed-file count must cover the selection; mypy output must
    /// parse strictly. Missing tools or unresolved imports under an ambient interpreter make
    /// coverage incomplete. Project-selected environment diagnostics remain findings.
    /// No environment is created or synchronized. Mypy configuration and checker environments
    /// can contain executable plugins, so the same trusted-repository requirement applies.
    PythonNative,
}

impl ProviderProfile {
    /// Every bundled profile in stable display order.
    pub const ALL: [Self; 4] = [
        Self::Fast,
        Self::RustNative,
        Self::NodeNative,
        Self::PythonNative,
    ];

    /// Stable ASP server identity advertised by this provider process.
    #[must_use]
    pub const fn provider_id(self) -> &'static str {
        match self {
            Self::Fast => PROVIDER_ID,
            Self::RustNative => RUST_NATIVE_PROVIDER_ID,
            Self::NodeNative => NODE_NATIVE_PROVIDER_ID,
            Self::PythonNative => PYTHON_NATIVE_PROVIDER_ID,
        }
    }

    /// Human-readable provider name used by the installed manifest.
    #[must_use]
    pub const fn provider_name(self) -> &'static str {
        match self {
            Self::Fast => PROVIDER_NAME,
            Self::RustNative => RUST_NATIVE_PROVIDER_NAME,
            Self::NodeNative => NODE_NATIVE_PROVIDER_NAME,
            Self::PythonNative => PYTHON_NATIVE_PROVIDER_NAME,
        }
    }

    /// Core rule namespace for this provider's diagnostics.
    #[must_use]
    pub const fn rule(self) -> &'static str {
        match self {
            Self::Fast => CORE_RULE,
            Self::RustNative => RUST_NATIVE_RULE,
            Self::NodeNative => NODE_NATIVE_RULE,
            Self::PythonNative => PYTHON_NATIVE_RULE,
        }
    }

    /// Versioned manifest capability profile name.
    #[must_use]
    pub const fn capability_profile(self) -> &'static str {
        match self {
            Self::Fast => CAPABILITY_PROFILE,
            Self::RustNative => RUST_NATIVE_CAPABILITY_PROFILE,
            Self::NodeNative => NODE_NATIVE_CAPABILITY_PROFILE,
            Self::PythonNative => PYTHON_NATIVE_CAPABILITY_PROFILE,
        }
    }

    /// Whether evaluation invokes a native toolchain or type checker.
    #[must_use]
    pub const fn is_native(self) -> bool {
        !matches!(self, Self::Fast)
    }

    /// Exact value accepted by the CLI's `--profile` selector.
    #[must_use]
    pub const fn cli_name(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::RustNative => "rust-native",
            Self::NodeNative => "node-native",
            Self::PythonNative => "python-native",
        }
    }
}

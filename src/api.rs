//! Application API and ASP integration overview.
//!
//! # Local commands
//!
//! [`check`] evaluates source selected by [`CheckArgs`]. Its default selection compares
//! current worktree changes with HEAD; `all` evaluates the entire supported source view.
//! [`run_sense`] examines exact dependency changes selected by [`SenseArgs`]. Both commands
//! print their result and return an error for blocking findings or unavailable coverage.
//! [`run_workflow`] combines Verify, Sense, and required native providers with the resolved
//! repository settings for post-edit, pre-commit, or CI.
//! [`doctor`], [`status`], and [`rules`] provide read-only operational information.
//!
//! # Provider API
//!
//! [`ProviderProfile`] documents every bundled provider, including its prerequisites,
//! command, supported scope, and execution boundary. Use [`serve_stdio_profile`] to start
//! one provider identity, or run `opcore serve --stdio --profile <profile>`.
//! [`render_provider_manifest`] produces the matching manifest after installation; its
//! executable path and checksum bind the exact installed binary.
//!
//! Every provider implements ASP Core `check/1.0` over JSON-RPC 2.0, with one UTF-8 JSON
//! object per line. The lifecycle is `initialize`, `initialized`, `check/evaluate`,
//! `shutdown`, then `exit`. Cancellation uses `$/cancelRequest`. Evaluation cannot begin
//! until the host's initialized grant permits it. Providers request exact immutable bytes
//! through host `workspace/listTree` and `workspace/readBlob` callbacks.
//!
//! A `check/evaluate` assessment contains diagnostics, coverage, and evidence bound to the
//! baseline, change digest, blobs read, effective configuration, and provider build.
//! `introduced` compares public diagnostic fingerprints; `all` returns current findings.
//! Providers never decide whether a change may be applied. The calling host owns decisions,
//! policy authority, isolation, and receipts. Opcore's private local runner is advisory
//! and does not issue an ASP adoption receipt.
//!
//! The complete request/response schemas, examples, and protocol specification are included
//! in the repository and platform archive under `asp/`; they are the normative wire API.
//! Hosts resolve repository and workflow settings and send the provider's effective
//! configuration with each request. The provider validates and binds those settings.
//!
//! # Rust embedding
//!
//! This module is the executable's supported Rust boundary; internal parser and graph types
//! are not a public library API. Asynchronous entrypoints require a Tokio runtime. For example,
//! an outer host can select an identity without invoking a repository tool:
//!
//! ```no_run
//! use opcore::api::{ProviderProfile, serve_stdio_profile};
//!
//! # async fn example() -> anyhow::Result<()> {
//! serve_stdio_profile(ProviderProfile::Fast).await?;
//! # Ok(())
//! # }
//! ```

pub use crate::{
    commands::{
        RepositoryArgs, configuration_schema, doctor, rules, status,
        workflows::{
            RunArgs, run as run_workflow, run_with_comparison as run_workflow_with_comparison,
        },
    },
    hooks::{Agent, ConfigureHookArgs, agent_gate, configure},
    policy::Workflow,
    protocol::{
        asp::ProviderProfile,
        cli::{CheckArgs, CheckComparison, CheckProvider, run as check},
        manifest::{render as render_manifest, render_for as render_provider_manifest},
        server::{serve_stdio, serve_stdio_profile, serve_stdio_profile_at},
    },
    sense::cli::{SenseArgs, run as run_sense},
};

/// Internal construction surface for integration tests and benchmarks.
///
/// This namespace is deliberately separate from the executable's supported application API.
// Exclude hidden test reexports from rustdoc's public reachability and missing-doc checks.
#[cfg(not(doc))]
#[doc(hidden)]
pub mod test_support;

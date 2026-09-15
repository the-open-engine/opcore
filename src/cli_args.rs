//! Shared executable argument definitions, also used by the documentation generator.

use clap::{Parser, Subcommand};
use opcore::api;
use std::path::PathBuf;

/// Fast source checks and dependency feedback for coding agents.
#[derive(Debug, Parser)]
#[command(
    name = "opcore",
    version,
    about,
    after_long_help = concat!(
        "Start with: opcore doctor --repo .\n",
        "Then run:   opcore check --repo . --all\n",
        "Without a selection flag, check compares current worktree changes with HEAD.\n",
        "Exit status: 0 accepted or nothing checked; 1 findings, coverage, or runtime failure;\n",
        "2 argument-parsing errors (installed hooks also use 2 for intervention)."
    )
)]
pub(crate) struct Cli {
    #[command(subcommand)]
    pub(crate) command: Command,
}

#[derive(Debug, Subcommand)]
pub(crate) enum Command {
    /// Run Verify, Sense, and configured native checks for post-edit, pre-commit, or CI.
    Run(api::RunArgs),
    /// Evaluate a local Git source view.
    Check(api::CheckArgs),
    /// Analyze exact local dependency changes and introduced runtime cycles.
    Sense(api::SenseArgs),
    /// Report effective configuration and workflow settings without evaluating source.
    Status(api::RepositoryArgs),
    /// Diagnose CLI setup, workflow prerequisites, and agent integrations.
    Doctor(api::RepositoryArgs),
    /// Render the exact built-in rule and policy manifest.
    Rules {
        /// Print the repository configuration JSON Schema for editor completion and validation.
        #[arg(long)]
        schema: bool,
    },
    /// Internal post-write adapter used by installed agent hooks.
    #[command(hide = true)]
    AgentGate,
    /// Internal owned hook configuration used by the installer.
    #[command(hide = true)]
    ConfigureHook(api::ConfigureHookArgs),
    /// Serve the ASP Core check provider over NDJSON stdio.
    Serve {
        /// Use standard input/output as the JSON-RPC transport.
        #[arg(long)]
        stdio: bool,
        /// Select the bundled provider process identity.
        #[arg(long, value_enum, default_value_t)]
        profile: api::ProviderProfile,
        /// Private local-host project path inside the callback workspace.
        #[arg(long, hide = true)]
        project_root: Option<String>,
    },
    /// Render an installed ASP manifest for an absolute binary path.
    Manifest {
        /// Absolute path to the installed executable whose bytes the manifest binds.
        #[arg(long)]
        executable: PathBuf,
        /// Select the bundled provider manifest.
        #[arg(long, value_enum, default_value_t)]
        profile: api::ProviderProfile,
    },
}

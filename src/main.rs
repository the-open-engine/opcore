use anyhow::Result;
use clap::Parser;
use opcore::api;

mod cli_args;
use cli_args::{Cli, Command};

fn main() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(dispatch(Cli::parse().command));
    // Tokio implements async stdin with a blocking reader. Do not let an ASP peer that keeps its
    // pipe open prevent process termination after the protocol's `exit` notification.
    runtime.shutdown_background();
    result
}

async fn dispatch(command: Command) -> Result<()> {
    match command {
        Command::Run {
            args,
            comparison: Some(comparison),
        } => api::run_workflow_with_comparison(args, comparison).await,
        Command::Run {
            args,
            comparison: None,
        } => api::run_workflow(args).await,
        Command::Check(args) => api::check(args).await,
        Command::Sense(args) => api::run_sense(args).await,
        Command::AgentGate => {
            if api::agent_gate().await {
                std::process::exit(2);
            }
            Ok(())
        }
        Command::Serve {
            stdio: true,
            profile,
            project_root,
        } => api::serve_stdio_profile_at(profile, project_root).await,
        Command::Serve { stdio: false, .. } => anyhow::bail!("serve currently requires --stdio"),
        command => dispatch_sync(command),
    }
}

fn dispatch_sync(command: Command) -> Result<()> {
    match command {
        Command::Status(args) => api::status(&args),
        Command::Doctor(args) => api::doctor(&args),
        Command::Rules { schema: false } => api::rules(),
        Command::Rules { schema: true } => api::configuration_schema(),
        Command::ConfigureHook(args) => api::configure(&args),
        Command::Manifest {
            executable,
            profile,
        } => {
            println!(
                "{}",
                serde_json::to_string_pretty(&api::render_provider_manifest(
                    &executable,
                    profile
                )?)?
            );
            Ok(())
        }
        Command::Run { .. }
        | Command::Check(_)
        | Command::Sense(_)
        | Command::AgentGate
        | Command::Serve { .. } => {
            anyhow::bail!("internal asynchronous command dispatch mismatch")
        }
    }
}

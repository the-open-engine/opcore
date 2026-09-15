//! Read-only inspection of the installer's hook receipts and exact configured entries.

use std::{env, path::PathBuf};

use anyhow::{Context as _, Result, ensure};
use serde_json::Value;

use super::{
    Agent, ConfigureHookArgs, OwnedHook, read_config, read_optional_bytes, read_receipt,
    receipt_entries, validate_receipt,
};

pub(crate) fn diagnose(agent: Agent) -> Result<Option<String>> {
    let Some(root) = agent_root(agent)? else {
        return Ok(None);
    };
    let args = inspection_args(agent, &root)?;
    if !inspect_installation(&args).with_context(|| {
        format!(
            "inspect hook setup at {}; repair agent settings and rerun installation",
            args.config.display()
        )
    })? {
        return Ok(None);
    }
    let next = match agent {
        Agent::Codex => {
            "restart Codex, review and trust the command in /hooks, then perform a smoke edit"
        }
        Agent::Claude => "restart Claude, inspect /hooks, then perform a smoke edit",
    };
    Ok(Some(format!(
        "owned PostToolUse configuration matches {}; host trust and live execution are unverified: {next}",
        args.config.display()
    )))
}

fn inspect_installation(args: &ConfigureHookArgs) -> Result<bool> {
    let receipt = read_receipt(&args.receipt)?;
    let enrollment = installed_enrollment(&args.receipt.with_file_name("install.receipt"))?;
    let Some(receipt) = receipt else {
        ensure!(
            !matches!(enrollment.as_deref(), Some("yes" | "pending")),
            "installed hook ownership receipt is missing at {}; rerun installation to repair it",
            args.receipt.display()
        );
        return Ok(false);
    };
    ensure!(
        enrollment.as_deref() != Some("no"),
        "hook receipt conflicts with disabled installation enrollment; rerun installation"
    );
    validate_receipt(&receipt, args)?;
    let owned = receipt_entries(&receipt, args)?;
    let (config, exists) = read_config(&args.config)?;
    ensure!(
        exists,
        "installed hook config is missing at {}; rerun installation",
        args.config.display()
    );
    verify_owned_entries(&config, &owned)?;
    ensure!(
        enrollment.as_deref() != Some("pending"),
        "hook installation is pending; rerun installation to finish enrollment"
    );
    Ok(true)
}

fn agent_root(agent: Agent) -> Result<Option<PathBuf>> {
    let (variable, directory) = match agent {
        Agent::Codex => ("CODEX_HOME", ".codex"),
        Agent::Claude => ("CLAUDE_CONFIG_DIR", ".claude"),
    };
    let root = env::var_os(variable)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(directory)));
    if let Some(root) = &root {
        ensure!(
            root.is_absolute(),
            "{variable} must resolve to an absolute agent directory"
        );
    }
    Ok(root)
}

fn inspection_args(agent: Agent, root: &std::path::Path) -> Result<ConfigureHookArgs> {
    Ok(ConfigureHookArgs {
        agent,
        config: root.join(match agent {
            Agent::Codex => "hooks.json",
            Agent::Claude => "settings.json",
        }),
        binary: env::current_exe().context("locate running Opcore binary")?,
        receipt: root.join("opcore/hook-install.json"),
        remove: false,
        check: true,
    })
}

fn installed_enrollment(path: &std::path::Path) -> Result<Option<String>> {
    let Some(bytes) = read_optional_bytes(path)? else {
        return Ok(None);
    };
    let values = bytes
        .split(|byte| *byte == b'\n')
        .filter_map(|line| line.strip_prefix(b"hooks "))
        .collect::<Vec<_>>();
    if values.is_empty() && legacy_install_receipt(&bytes) {
        return Ok(None);
    }
    ensure!(
        values.len() == 1 && matches!(values[0], b"yes" | b"no" | b"pending"),
        "cannot read hook enrollment from {}; rerun installation to repair its receipt",
        path.display()
    );
    Ok(Some(String::from_utf8_lossy(values[0]).into_owned()))
}

fn legacy_install_receipt(bytes: &[u8]) -> bool {
    matches!(
        bytes.split(|byte| *byte == b'\n').next(),
        Some(
            b"opcore.install.v1"
                | b"opcore.install.v2"
                | b"opcore.install.v3"
                | b"opcore.install.v4"
        )
    )
}

fn verify_owned_entries(config: &Value, owned: &[OwnedHook]) -> Result<()> {
    let groups = config
        .get("hooks")
        .and_then(|hooks| hooks.get("PostToolUse"))
        .and_then(Value::as_array)
        .context(
            "installed PostToolUse hook configuration is missing or malformed; rerun installation",
        )?;
    for entry in owned {
        let count = groups
            .iter()
            .filter(|group| group.get("matcher").and_then(Value::as_str) == Some(&entry.matcher))
            .filter_map(|group| group.get("hooks").and_then(Value::as_array))
            .flatten()
            .filter(|configured| **configured == entry.entry)
            .count();
        ensure!(
            count == 1,
            "owned PostToolUse hook is missing, modified, or duplicated; inspect agent /hooks and rerun installation"
        );
    }
    Ok(())
}

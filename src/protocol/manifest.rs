use std::path::Path;

use super::{
    artifact,
    asp::{MANIFEST_VERSION, PROTOCOL_VERSION, ProviderProfile},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

/// Renders a manifest bound to the exact installed executable bytes.
///
/// # Errors
///
/// Returns an error when the path is not an absolute regular file or cannot be canonicalized,
/// opened, read, or hashed.
pub fn render(executable: &Path) -> Result<Value> {
    render_for(executable, ProviderProfile::Fast)
}

/// Renders one bundled provider manifest bound to the exact installed executable bytes.
///
/// # Errors
///
/// Returns an error when the path is not an absolute regular file or cannot be canonicalized,
/// opened, read, or hashed.
pub fn render_for(executable: &Path, profile: ProviderProfile) -> Result<Value> {
    ensure!(
        executable.is_absolute(),
        "installed executable path must be absolute"
    );
    let executable = executable
        .canonicalize()
        .context("canonicalize installed executable")?;
    let digest = artifact::digest_path(&executable).context("hash installed executable")?;
    let sha256 = digest
        .strip_prefix("sha256:")
        .context("installed executable digest has an invalid domain")?
        .to_owned();
    let settings = manifest_profile(profile);
    Ok(json!({
        "manifestVersion": MANIFEST_VERSION,
        "server": {
            "id": profile.provider_id(),
            "name": profile.provider_name(),
            "version": env!("CARGO_PKG_VERSION")
        },
        "protocolVersions": [PROTOCOL_VERSION],
        "roles": ["judge"],
        "capabilities": ["check"],
        "capabilityProfiles": [profile.capability_profile()],
        "entrypoint": {
            "transport": "stdio",
            "bin": executable,
            "args": settings.arguments
        },
        "artifact": {
            "fingerprint": digest,
            "checksums": [{ "path": executable, "sha256": sha256 }]
        },
        "provenance": {
            "publisher": "the-open-engine",
            "source": "https://github.com/the-open-engine/opcore",
            "license": "Apache-2.0"
        },
        "accessExpectations": {
            "filesystem": { "read": settings.filesystem_read, "write": settings.filesystem_write },
            "network": { "outbound": false, "allowlist": [] },
            "secrets": { "names": [] },
            "environment": { "inherit": false, "variables": settings.environment },
            "dataClasses": settings.data_classes
        }
    }))
}

struct ManifestProfile {
    arguments: Value,
    environment: Vec<&'static str>,
    filesystem_read: Vec<&'static str>,
    filesystem_write: Vec<&'static str>,
    data_classes: Vec<&'static str>,
}

fn manifest_profile(profile: ProviderProfile) -> ManifestProfile {
    match profile {
        ProviderProfile::Fast => ManifestProfile {
            arguments: json!(["serve", "--stdio"]),
            environment: Vec::new(),
            filesystem_read: Vec::new(),
            filesystem_write: Vec::new(),
            data_classes: vec!["source-code", "diff-metadata"],
        },
        ProviderProfile::RustNative => {
            let mut environment = super::native::child_environment(profile).to_vec();
            environment.push("OPCORE_CARGO");
            ManifestProfile {
                arguments: json!(["serve", "--stdio", "--profile", "rust-native"]),
                environment,
                filesystem_read: vec!["host-provided-rust-toolchain", "host-provided-cargo-cache"],
                filesystem_write: vec![
                    "provider-private-scratch",
                    "host-provided-cargo-cache",
                    "host-provided-rust-toolchain",
                ],
                data_classes: vec!["source-code", "repository-content", "diff-metadata"],
            }
        }
        ProviderProfile::NodeNative => native_manifest_profile(
            profile,
            "OPCORE_NPM",
            "host-provided-node-toolchain",
            "host-provided-npm-cache",
            true,
        ),
        ProviderProfile::PythonNative => native_manifest_profile(
            profile,
            "OPCORE_PYRIGHT",
            "host-provided-python-type-checker",
            "host-provided-python-environment",
            false,
        ),
    }
}

fn native_manifest_profile(
    profile: ProviderProfile,
    configured_tool: &'static str,
    toolchain: &'static str,
    cache: &'static str,
    writable_cache: bool,
) -> ManifestProfile {
    let mut environment = super::native::child_environment(profile).to_vec();
    environment.push(configured_tool);
    if profile == ProviderProfile::PythonNative {
        environment.push("OPCORE_MYPY");
    }
    let mut filesystem_write = vec!["provider-private-scratch"];
    if writable_cache {
        filesystem_write.push(cache);
    }
    ManifestProfile {
        arguments: json!(["serve", "--stdio", "--profile", profile.cli_name()]),
        environment,
        filesystem_read: vec![toolchain, cache],
        filesystem_write,
        data_classes: vec!["source-code", "repository-content", "diff-metadata"],
    }
}

use serde::{Deserialize, Serialize};

pub const ARTIFACT_NAME: &str = "lattice-graph-core";
pub const ARTIFACT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphProviderArtifactMetadata {
    pub artifact_name: String,
    pub artifact_version: String,
    pub target_platform: String,
    pub binary_path: String,
    pub checksum_path: String,
    pub checksum_sha256: String,
    pub build_profile: String,
}

pub fn target_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

pub fn runtime_artifact_metadata() -> GraphProviderArtifactMetadata {
    GraphProviderArtifactMetadata {
        artifact_name: ARTIFACT_NAME.to_string(),
        artifact_version: ARTIFACT_VERSION.to_string(),
        target_platform: target_platform(),
        binary_path: ARTIFACT_NAME.to_string(),
        checksum_path: format!("{ARTIFACT_NAME}.sha256"),
        checksum_sha256: "runtime-unpackaged".to_string(),
        build_profile: "runtime".to_string(),
    }
}

pub fn boundary_name() -> &'static str {
    "artifact metadata boundary"
}

use std::process::Command;

use serde_json::Value;

fn render(profile: Option<&str>) -> Value {
    let binary = assert_cmd::cargo::cargo_bin!("opcore");
    let mut command = Command::new(binary);
    command.args(["manifest", "--executable"]).arg(binary);
    if let Some(profile) = profile {
        command.args(["--profile", profile]);
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn renders_absolute_checksum_bound_check_only_manifest() {
    let manifest = render(None);
    assert_eq!(manifest["manifestVersion"], "asp-server/1.0");
    assert_eq!(manifest["server"]["id"], "opcore");
    assert_eq!(manifest["capabilities"], serde_json::json!(["check"]));
    assert_eq!(
        manifest["entrypoint"]["args"],
        serde_json::json!(["serve", "--stdio"])
    );
    assert!(
        manifest["entrypoint"]["bin"]
            .as_str()
            .unwrap()
            .starts_with('/')
    );
    let checksum = manifest["artifact"]["checksums"][0]["sha256"]
        .as_str()
        .unwrap();
    assert_eq!(checksum.len(), 64);
    let text = serde_json::to_string(&manifest).unwrap();
    for forbidden in [
        "certificate",
        "certified",
        "authority",
        "decision",
        "verdict",
    ] {
        assert!(!text.to_ascii_lowercase().contains(forbidden));
    }
}

#[test]
fn renders_the_bundled_rust_native_profile() {
    let manifest = render(Some("rust-native"));
    assert_eq!(manifest["server"]["id"], "opcore-rust-native");
    assert_eq!(
        manifest["capabilityProfiles"],
        serde_json::json!(["opcore/rust-native"])
    );
    assert_eq!(
        manifest["entrypoint"]["args"],
        serde_json::json!(["serve", "--stdio", "--profile", "rust-native"])
    );
    assert_eq!(
        manifest["accessExpectations"]["environment"]["variables"],
        serde_json::json!([
            "PATH",
            "HOME",
            "CARGO_HOME",
            "RUSTUP_HOME",
            "SystemRoot",
            "WINDIR",
            "PATHEXT",
            "OPCORE_CARGO"
        ])
    );
    assert_eq!(
        manifest["accessExpectations"]["filesystem"],
        serde_json::json!({
            "read": ["host-provided-rust-toolchain", "host-provided-cargo-cache"],
            "write": [
                "provider-private-scratch",
                "host-provided-cargo-cache",
                "host-provided-rust-toolchain"
            ]
        })
    );
    assert_eq!(
        manifest["artifact"]["checksums"][0]["sha256"],
        manifest["artifact"]["fingerprint"]
            .as_str()
            .unwrap()
            .strip_prefix("sha256:")
            .unwrap()
    );
}

#[test]
fn renders_the_bundled_node_native_profile() {
    let manifest = render(Some("node-native"));
    assert_eq!(manifest["server"]["id"], "opcore-node-native");
    assert_eq!(
        manifest["capabilityProfiles"],
        serde_json::json!(["opcore/node-native"])
    );
    assert_eq!(
        manifest["entrypoint"]["args"],
        serde_json::json!(["serve", "--stdio", "--profile", "node-native"])
    );
    assert_eq!(
        manifest["accessExpectations"]["environment"]["variables"],
        serde_json::json!([
            "PATH",
            "HOME",
            "NPM_CONFIG_CACHE",
            "SystemRoot",
            "WINDIR",
            "PATHEXT",
            "OPCORE_NPM"
        ])
    );
    assert_eq!(
        manifest["accessExpectations"]["filesystem"],
        serde_json::json!({
            "read": ["host-provided-node-toolchain", "host-provided-npm-cache"],
            "write": ["provider-private-scratch", "host-provided-npm-cache"]
        })
    );
}

#[test]
fn renders_the_bundled_python_native_profile() {
    let manifest = render(Some("python-native"));
    assert_eq!(manifest["server"]["id"], "opcore-python-native");
    assert_eq!(
        manifest["capabilityProfiles"],
        serde_json::json!(["opcore/python-native"])
    );
    assert_eq!(
        manifest["entrypoint"]["args"],
        serde_json::json!(["serve", "--stdio", "--profile", "python-native"])
    );
    assert_eq!(
        manifest["accessExpectations"]["environment"]["variables"],
        serde_json::json!([
            "PATH",
            "HOME",
            "SystemRoot",
            "WINDIR",
            "PATHEXT",
            "OPCORE_PYTHON",
            "OPCORE_PYTHON_SOURCE",
            "OPCORE_PYRIGHT",
            "OPCORE_MYPY"
        ])
    );
    assert_eq!(
        manifest["accessExpectations"]["filesystem"],
        serde_json::json!({
            "read": [
                "host-provided-python-type-checker",
                "host-provided-python-environment"
            ],
            "write": ["provider-private-scratch"]
        })
    );
}

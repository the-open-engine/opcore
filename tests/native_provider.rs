use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt as _,
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Output, Stdio},
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

mod support;

use support::RepositoryFixture;

const MANIFEST: &str = r#"[package]
name = "native-fixture"
version = "0.1.0"
edition = "2024"

[lib]
path = "src/lib.rs"
"#;
const CLEAN_SOURCE: &str = "pub fn answer() -> u32 { 42 }\n";
const BROKEN_SOURCE: &str = "pub fn answer() -> u32 { \"forty-two\" }\n";

fn run_local_host(fixture: &RepositoryFixture) -> Output {
    Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .args(["check", "--repo"])
        .arg(fixture.repo())
        .args([
            "--changed",
            "--native",
            "--allow-unsandboxed-native",
            "--json",
            "--advisory",
        ])
        .env("XDG_CACHE_HOME", fixture.cache())
        .output()
        .unwrap()
}

fn run_selected_host(
    fixture: &RepositoryFixture,
    provider: &str,
    root: &str,
    variable: &str,
    tool: &Path,
) -> Output {
    Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .args(["check", "--repo"])
        .arg(fixture.repo())
        .args([
            "--changed",
            "--providers",
            provider,
            "--roots",
            root,
            "--json",
            "--advisory",
            "--allow-unsandboxed-native",
        ])
        .env("XDG_CACHE_HOME", fixture.cache())
        .env(variable, tool)
        .output()
        .unwrap()
}

fn executable(path: &Path, source: &str) {
    fs::write(path, source).unwrap();
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(path, permissions).unwrap();
}

#[test]
fn native_cli_requires_consent_and_keeps_json_machine_readable() {
    let fixture = RepositoryFixture::new(&[("Cargo.toml", MANIFEST), ("src/lib.rs", CLEAN_SOURCE)]);
    let output = Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .args(["check", "--repo"])
        .arg(fixture.repo())
        .args(["--native", "--json"])
        .env("XDG_CACHE_HOME", fixture.cache())
        .output()
        .unwrap();

    assert!(!output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["schema"], "opcore.host-check-error.v1");
    assert_eq!(report["decision"], "indeterminate");
    assert!(
        report["message"]
            .as_str()
            .unwrap()
            .contains("--allow-unsandboxed-native")
    );
}

fn fake_pyright(path: &Path) {
    executable(
        path,
        r#"#!/bin/sh
target=app.py
for argument in "$@"; do
  case "$argument" in
    *.py|*.pyi) target=$argument ;;
  esac
done
if grep -q BROKEN "$target"; then
  cat <<JSON
{
  "generalDiagnostics": [{
    "file": "$target",
    "severity": "error",
    "message": "simulated assignment failure",
    "range": {
      "start": {"line": 0, "character": 13},
      "end": {"line": 0, "character": 19}
    },
    "rule": "reportAssignmentType"
  }],
  "summary": {"filesAnalyzed": 1, "errorCount": 1, "warningCount": 0, "informationCount": 0}
}
JSON
  exit 1
fi
cat <<'JSON'
{
  "generalDiagnostics": [],
  "summary": {"filesAnalyzed": 1, "errorCount": 0, "warningCount": 0, "informationCount": 0}
}
JSON
exit 0
"#,
    );
}

fn fake_npm(path: &Path) {
    executable(
        path,
        r#"#!/bin/sh
mkdir -p node_modules/.bin
cat > node_modules/.bin/tsc <<'EOF'
#!/bin/sh
if grep -q BROKEN src/index.ts; then
  echo "src/index.ts(1,30): error TS2322: simulated type failure"
  echo "$PWD/src/index.ts"
  exit 1
fi
echo "$PWD/src/index.ts"
exit 0
EOF
chmod 700 node_modules/.bin/tsc
exit 0
"#,
    );
}

fn run_fake_node_host(fixture: &RepositoryFixture, root: &str) -> Output {
    let tools = tempfile::tempdir().unwrap();
    let npm = tools.path().join("npm");
    fake_npm(&npm);
    run_selected_host(fixture, "node-native", root, "OPCORE_NPM", &npm)
}

fn node_project_fixture() -> RepositoryFixture {
    let fixture = RepositoryFixture::new(&[
        ("apps/web/package.json", r#"{"private":true}"#),
        ("apps/web/package-lock.json", "{}\n"),
        ("apps/web/tsconfig.json", "{}\n"),
        (
            "apps/web/src/index.ts",
            "export const value: string = \"clean\";\n",
        ),
    ]);
    fixture.write(
        "apps/web/src/index.ts",
        "export const value: string = BROKEN;\n",
    );
    fixture
}

fn run_fake_python_host(fixture: &RepositoryFixture, root: &str) -> Output {
    let tools = tempfile::tempdir().unwrap();
    let pyright = tools.path().join("pyright");
    fake_pyright(&pyright);
    let environment = fixture.repo().join("services/python/.venv");
    fs::create_dir_all(environment.join("bin")).unwrap();
    executable(&environment.join("bin/python"), "#!/bin/sh\nexit 0\n");
    fs::write(
        environment.join("pyvenv.cfg"),
        "home = /usr/bin\ninclude-system-site-packages = false\n",
    )
    .unwrap();
    run_selected_host(fixture, "python-native", root, "OPCORE_PYRIGHT", &pyright)
}

fn selected_provider(output: &Output, root: &str, provider_id: &str) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["decision"], "deny", "{report}");
    let provider = report["providers"][0].clone();
    assert_eq!(provider["root"], root);
    assert_eq!(provider["id"], provider_id);
    assert_eq!(provider["assessment"]["status"], "complete", "{report}");
    provider
}

fn blob_ref(bytes: &[u8]) -> String {
    format!("blob:sha256:{}", hex::encode(Sha256::digest(bytes)))
}

struct NativeProvider {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    baseline: Value,
}

impl NativeProvider {
    fn start() -> Self {
        Self::start_with_cargo(None)
    }

    fn start_with_cargo(cargo: Option<&Path>) -> Self {
        let mut command = Command::new(assert_cmd::cargo::cargo_bin!("opcore"));
        command
            .args(["serve", "--stdio", "--profile", "rust-native"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cargo) = cargo {
            command.env("OPCORE_CARGO", cargo);
        }
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            stdin,
            stdout,
            baseline: json!({ "rev": "git:tree:native-empty" }),
        }
    }

    fn send(&mut self, value: &Value) {
        serde_json::to_writer(&mut self.stdin, value).unwrap();
        self.stdin.write_all(b"\n").unwrap();
        self.stdin.flush().unwrap();
    }

    fn receive(&mut self) -> Value {
        let mut line = String::new();
        assert!(
            self.stdout.read_line(&mut line).unwrap() > 0,
            "provider closed stdout"
        );
        serde_json::from_str(&line).unwrap()
    }

    fn initialize(&mut self) -> Value {
        let initialize = json!({
            "jsonrpc": "2.0", "id": "initialize", "method": "initialize", "params": {
                "protocolVersion": "asp/1.0",
                "host": { "name": "native-test-host", "version": "0.1.0" },
                "workspace": { "root": "/candidate", "baseline": self.baseline }
            }
        });
        self.send(&initialize);
        let response = self.receive();
        let initialized = json!({
            "jsonrpc": "2.0", "method": "initialized", "params": {
                "grantedPermissions": {
                    "read": ["**/*"], "write": false, "network": false,
                    "resourceLimits": { "wallclockMs": 60_000 }
                },
                "baseline": self.baseline
            }
        });
        self.send(&initialized);
        response
    }

    fn evaluate(&mut self, id: &str, source: &str) -> Value {
        self.evaluate_with_comparison(id, source, "all")
    }

    fn evaluate_empty_workspace(&mut self, id: &str) -> Value {
        self.send(&json!({
            "jsonrpc": "2.0", "id": id, "method": "check/evaluate", "params": {
                "changeset": { "baseline": self.baseline, "changes": [] },
                "scope": "workspace", "comparison": "all"
            }
        }));
        loop {
            let frame = self.receive();
            match frame.get("method").and_then(Value::as_str) {
                Some("workspace/listTree") => self.send(&json!({
                    "jsonrpc": "2.0", "id": frame["id"],
                    "result": { "entries": [], "truncated": false }
                })),
                Some("workspace/readBlob") => {
                    panic!("not-applicable native workspace must not read blobs")
                }
                None if frame["id"] == id => return frame,
                _ => panic!("unexpected native provider frame: {frame}"),
            }
        }
    }

    fn evaluate_with_comparison(&mut self, id: &str, source: &str, comparison: &str) -> Value {
        let manifest_id = blob_ref(MANIFEST.as_bytes());
        let source_id = blob_ref(source.as_bytes());
        let blobs = BTreeMap::from([
            (manifest_id.clone(), MANIFEST.as_bytes()),
            (source_id.clone(), source.as_bytes()),
        ]);
        let request = json!({
            "jsonrpc": "2.0", "id": id, "method": "check/evaluate", "params": {
                "changeset": {
                    "baseline": self.baseline,
                    "changes": [
                        { "path": "Cargo.toml", "kind": "create", "after": manifest_id },
                        { "path": "src/lib.rs", "kind": "create", "after": source_id }
                    ]
                },
                "scope": "workspace",
                "comparison": comparison
            }
        });
        self.send(&request);
        loop {
            let frame = self.receive();
            match frame.get("method").and_then(Value::as_str) {
                Some("workspace/listTree") => {
                    assert_eq!(frame["params"]["baseline"], self.baseline);
                    assert!(frame["params"].get("paths").is_none());
                    self.send(&json!({
                        "jsonrpc": "2.0", "id": frame["id"],
                        "result": { "entries": [], "truncated": false }
                    }));
                }
                Some("workspace/readBlob") => {
                    let requested = frame["params"]["blobs"].as_array().unwrap();
                    let results = requested
                        .iter()
                        .map(|value| {
                            let blob = value.as_str().unwrap();
                            let bytes = blobs.get(blob).unwrap_or_else(|| {
                                panic!("provider requested unknown blob {blob}")
                            });
                            json!({
                                "id": blob,
                                "encoding": "utf-8",
                                "bytes": std::str::from_utf8(bytes).unwrap()
                            })
                        })
                        .collect::<Vec<_>>();
                    self.send(&json!({
                        "jsonrpc": "2.0", "id": frame["id"],
                        "result": { "blobs": results }
                    }));
                }
                None if frame["id"] == id => return frame,
                _ => panic!("unexpected native provider frame: {frame}"),
            }
        }
    }

    fn shutdown(mut self) {
        self.send(&json!({
            "jsonrpc": "2.0", "id": "shutdown", "method": "shutdown"
        }));
        assert_eq!(self.receive()["result"], Value::Null);
        self.send(&json!({ "jsonrpc": "2.0", "method": "exit" }));
        drop(self.stdin);
        let output = self.child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn rust_native_skips_tool_setup_and_blob_reads_when_not_applicable() {
    let scratch = tempfile::tempdir().unwrap();
    let missing_cargo = scratch.path().join("missing-cargo");
    let mut provider = NativeProvider::start_with_cargo(Some(&missing_cargo));
    provider.initialize();

    let response = provider.evaluate_empty_workspace("not-applicable");
    assert!(response.get("error").is_none(), "{response}");
    assert_eq!(response["result"]["status"], "unsupported", "{response}");
    assert_eq!(response["result"]["validAsOf"]["blobs"], json!([]));
    provider.shutdown();
}

#[test]
fn rust_native_profile_materializes_callbacks_and_reports_cargo_results() {
    let mut provider = NativeProvider::start();
    let initialized = provider.initialize();
    assert_eq!(
        initialized["result"]["serverInfo"]["name"],
        "opcore-rust-native"
    );
    assert_eq!(
        initialized["result"]["serverInfo"]["fingerprint"],
        opcore::api::test_support::build_digest()
    );
    assert_eq!(
        initialized["result"]["capabilities"]["check"]["diagnosticSources"],
        json!(["opcore-rust-native"])
    );
    assert_eq!(
        initialized["result"]["capabilities"]["check"]["scopes"],
        json!(["workspace"])
    );
    assert_eq!(
        initialized["result"]["capabilities"]["check"]["comparisons"],
        json!(["introduced", "all"])
    );

    let clean = provider.evaluate("clean", CLEAN_SOURCE);
    assert_eq!(clean["result"]["status"], "complete", "{clean}");
    assert_eq!(clean["result"]["diagnostics"], json!([]));
    assert_eq!(clean["result"]["provider"]["id"], "opcore-rust-native");
    assert_eq!(clean["result"]["coverage"]["exhaustive"], true);
    assert_eq!(
        clean["result"]["evidence"][0]["data"]["candidate"]["argv"],
        json!([
            "check",
            "--workspace",
            "--all-targets",
            "--message-format=json"
        ])
    );
    assert_eq!(
        clean["result"]["evidence"][0]["data"]["candidate"]["cargoOffline"],
        true
    );

    let findings = provider.evaluate("findings", BROKEN_SOURCE);
    assert_eq!(findings["result"]["status"], "complete", "{findings}");
    let diagnostics = findings["result"]["diagnostics"].as_array().unwrap();
    assert!(diagnostics.iter().any(|diagnostic| {
        diagnostic["code"] == "opcore-rust-native/cargo-check"
            && diagnostic["source"] == "opcore-rust-native"
            && diagnostic["severity"] == "error"
            && diagnostic["location"]["path"] == "src/lib.rs"
    }));
    assert!(
        diagnostics
            .iter()
            .all(|diagnostic| diagnostic.get("introduced").is_none())
    );
    let introduced =
        provider.evaluate_with_comparison("introduced-new-project", BROKEN_SOURCE, "introduced");
    assert_eq!(introduced["result"]["status"], "complete", "{introduced}");
    assert!(
        introduced["result"]["diagnostics"]
            .as_array()
            .is_some_and(|diagnostics| !diagnostics.is_empty())
    );
    assert!(
        introduced["result"]["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .all(|diagnostic| diagnostic["introduced"] == true)
    );
    provider.shutdown();
}

#[test]
fn local_native_host_combines_fast_and_cargo_assessments() {
    let fixture = RepositoryFixture::new(&[("Cargo.toml", MANIFEST), ("src/lib.rs", CLEAN_SOURCE)]);
    fixture.write("src/lib.rs", BROKEN_SOURCE);

    let output = run_local_host(&fixture);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "invalid host report: {error}\nstdout={}\nstderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    });
    assert_eq!(report["schema"], "opcore.host-check.v3");
    assert_eq!(report["decision"], "deny", "{report}");
    assert_eq!(report["workspaces"][0]["root"], ".");
    assert_eq!(report["assurance"]["mode"], "advisory");
    assert!(
        report["policyDigest"]
            .as_str()
            .is_some_and(|digest| digest.starts_with("sha256:"))
    );
    let providers = report["providers"].as_array().unwrap();
    assert_eq!(providers.len(), 2);
    assert!(providers.iter().any(|provider| {
        provider["id"] == "opcore" && provider["assessment"]["status"] == "complete"
    }));
    let native = providers
        .iter()
        .find(|provider| provider["id"] == "opcore-rust-native")
        .unwrap();
    assert_eq!(native["failure"], Value::Null, "{native}");
    assert_eq!(native["assessment"]["status"], "complete", "{native}");
    assert!(
        native["assessment"]["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| {
                diagnostic["code"] == "opcore-rust-native/cargo-check"
                    && diagnostic["location"]["path"] == "src/lib.rs"
            })
    );
    assert!(!fixture.repo().join("target").exists());
    assert!(!fixture.repo().join("Cargo.lock").exists());
}

#[test]
fn local_host_exposes_comparison_and_per_provider_timing() {
    let fixture = RepositoryFixture::new(&[("src/lib.rs", "pub fn broken(\n")]);
    let run = |comparison: &str, json: bool| {
        let mut command = Command::new(assert_cmd::cargo::cargo_bin!("opcore"));
        command
            .args(["check", "--repo"])
            .arg(fixture.repo())
            .args([
                "--providers",
                "fast",
                "--comparison",
                comparison,
                "--advisory",
            ])
            .env("XDG_CACHE_HOME", fixture.cache());
        if json {
            command.arg("--json");
        }
        command.output().unwrap()
    };

    let introduced: Value = serde_json::from_slice(&run("introduced", true).stdout).unwrap();
    assert_eq!(introduced["comparison"], "introduced");
    assert_eq!(introduced["decision"], "allow", "{introduced}");
    assert_eq!(
        introduced["providers"][0]["assessment"]["diagnostics"],
        json!([])
    );

    let all = run("all", true);
    assert!(all.status.success());
    let all: Value = serde_json::from_slice(&all.stdout).unwrap();
    assert_eq!(all["comparison"], "all");
    assert_eq!(all["decision"], "deny", "{all}");
    assert!(
        all["providers"][0]["assessment"]["timing"]["elapsedMs"]
            .as_u64()
            .is_some()
    );

    let human = run("all", false);
    assert!(human.status.success());
    let human = String::from_utf8(human.stdout).unwrap();
    assert!(human.contains("all comparison"), "{human}");
    assert!(human.contains(" ms)"), "{human}");
}

#[test]
fn selected_node_provider_typechecks_a_rebased_subfolder() {
    let fixture = node_project_fixture();
    let output = run_fake_node_host(&fixture, "apps/web");
    let provider = selected_provider(&output, "apps/web", "opcore-node-native");
    assert_eq!(
        provider["assessment"]["diagnostics"][0]["location"]["path"],
        "src/index.ts"
    );
    assert!(!fixture.repo().join("apps/web/node_modules").exists());
}

#[test]
fn node_focus_keeps_nearest_parent_project_context() {
    let fixture = node_project_fixture();
    fixture.write("apps/web/shared.ts", "export const shared = true;\n");
    let output = run_fake_node_host(&fixture, "apps/web/src");
    let provider = selected_provider(&output, "apps/web/src", "opcore-node-native");
    assert_eq!(provider["context"], "apps/web");
    assert_eq!(
        provider["assessment"]["evidence"][0]["data"]["candidate"]["selectedSourceFiles"],
        2
    );
    assert_eq!(
        provider["assessment"]["diagnostics"][0]["location"]["path"],
        "src/index.ts"
    );
}

#[test]
fn selected_python_provider_typechecks_a_rebased_subfolder() {
    let fixture = RepositoryFixture::new(&[
        (
            "services/python/pyproject.toml",
            "[tool.pyright]\ninclude = [\"app.py\"]\n",
        ),
        ("services/python/app.py", "value: str = \"clean\"\n"),
    ]);
    fixture.write("services/python/app.py", "value: str = BROKEN\n");
    let output = run_fake_python_host(&fixture, "services/python");
    let provider = selected_provider(&output, "services/python", "opcore-python-native");
    assert_eq!(
        provider["assessment"]["diagnostics"][0]["location"]["path"],
        "app.py"
    );
    assert_eq!(
        provider["assessment"]["evidence"][0]["data"]["candidate"]["pythonEnvironment"]["source"],
        "project-dot-venv"
    );
    assert!(
        provider["assessment"]["evidence"][0]["data"]["candidate"]["pythonEnvironment"]
            ["markerDigest"]
            .as_str()
            .is_some_and(|digest| digest.starts_with("sha256:"))
    );
}

#[test]
fn python_focus_keeps_nearest_parent_configuration() {
    let fixture = RepositoryFixture::new(&[
        (
            "services/python/pyproject.toml",
            "[tool.pyright]\ninclude = [\"src\"]\n",
        ),
        ("services/python/src/app.py", "value: str = \"clean\"\n"),
    ]);
    fixture.write("services/python/src/app.py", "value: str = BROKEN\n");
    let output = run_fake_python_host(&fixture, "services/python/src");
    let provider = selected_provider(&output, "services/python/src", "opcore-python-native");
    assert_eq!(provider["context"], "services/python");
    assert_eq!(
        provider["assessment"]["diagnostics"][0]["location"]["path"],
        "src/app.py"
    );
}

#[test]
fn selected_rust_package_keeps_parent_workspace_context() {
    let fixture = RepositoryFixture::new(&[
        (
            "Cargo.toml",
            r#"[workspace]
resolver = "2"
members = ["app", "dep"]

[workspace.package]
edition = "2024"
"#,
        ),
        (
            "app/Cargo.toml",
            r#"[package]
name = "app"
version = "0.1.0"
edition.workspace = true

[dependencies]
dep = { path = "../dep" }
"#,
        ),
        (
            "app/src/lib.rs",
            concat!(
                "pub const DATA: &str = include_str!(\"../../protocol/value.txt\");\n",
                "pub fn answer() -> u32 { dep::answer() }\n"
            ),
        ),
        (
            "dep/Cargo.toml",
            r#"[package]
name = "dep"
version = "0.1.0"
edition.workspace = true
"#,
        ),
        ("dep/src/lib.rs", "pub fn answer() -> u32 { 42 }\n"),
        ("protocol/value.txt", "captured sibling resource\n"),
    ]);
    fixture.write(
        "app/src/lib.rs",
        "pub const DATA: &str = include_str!(\"../../protocol/value.txt\");\npub fn answer() -> u32 { \"broken\" }\n",
    );

    let output = Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .args(["check", "--repo"])
        .arg(fixture.repo())
        .args([
            "--providers",
            "rust-native",
            "--roots",
            "app",
            "--allow-unsandboxed-native",
            "--json",
            "--advisory",
        ])
        .env("XDG_CACHE_HOME", fixture.cache())
        .output()
        .unwrap();
    let provider = selected_provider(&output, "app", "opcore-rust-native");
    assert_eq!(provider["context"], ".");
    assert_eq!(
        provider["assessment"]["diagnostics"][0]["location"]["path"], "app/src/lib.rs",
        "{provider}"
    );
    assert_eq!(
        provider["assessment"]["evidence"][0]["data"]["candidate"]["projectRoot"],
        "app"
    );
    assert!(!fixture.repo().join("target").exists());
}

#[test]
fn provider_sets_and_multiple_roots_are_explicit() {
    let fixture = RepositoryFixture::new(&[
        ("services/a/app.py", "value: str = \"clean\"\n"),
        ("services/b/app.py", "value: str = \"clean\"\n"),
    ]);
    fixture.write("services/b/app.py", "value: str = BROKEN\n");
    let tools = tempfile::tempdir().unwrap();
    let pyright = tools.path().join("pyright");
    fake_pyright(&pyright);

    let output = Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .args(["check", "--repo"])
        .arg(fixture.repo())
        .args([
            "--providers",
            "fast,python-native",
            "--roots",
            "services/a,services/b",
            "--allow-unsandboxed-native",
            "--json",
            "--advisory",
        ])
        .env("XDG_CACHE_HOME", fixture.cache())
        .env("OPCORE_PYRIGHT", &pyright)
        .output()
        .unwrap();
    assert!(output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["decision"], "deny", "{report}");
    let workspaces = report["workspaces"].as_array().unwrap();
    assert_eq!(workspaces.len(), 4);
    assert_eq!(workspaces[0]["root"], "services/a");
    assert_eq!(workspaces[0]["provider"], "opcore");
    assert_eq!(workspaces[1]["provider"], "opcore-python-native");
    assert_eq!(workspaces[2]["root"], "services/b");
    assert_eq!(workspaces[3]["provider"], "opcore-python-native");
    let providers = report["providers"].as_array().unwrap();
    assert_eq!(providers.len(), 4);
    assert!(
        providers
            .iter()
            .all(|provider| provider["skipped"].is_null())
    );
    assert_eq!(providers[0]["id"], "opcore");
    assert_eq!(providers[1]["id"], "opcore-python-native");
    assert_eq!(providers[2]["id"], "opcore");
    assert_eq!(providers[3]["id"], "opcore-python-native");

    let all = Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .args(["check", "--repo"])
        .arg(fixture.repo())
        .args([
            "--providers",
            "all",
            "--roots",
            "services/b",
            "--allow-unsandboxed-native",
            "--json",
            "--advisory",
        ])
        .env("XDG_CACHE_HOME", fixture.cache())
        .env("OPCORE_PYRIGHT", &pyright)
        .output()
        .unwrap();
    assert!(all.status.success());
    let all: Value = serde_json::from_slice(&all.stdout).unwrap();
    let providers = all["providers"].as_array().unwrap();
    assert_eq!(providers.len(), 4);
    assert_eq!(providers[0]["id"], "opcore");
    assert_eq!(providers[1]["skipped"], "no root Cargo.toml");
    assert_eq!(
        providers[2]["skipped"],
        "no root locked npm TypeScript project"
    );
    assert_eq!(providers[3]["id"], "opcore-python-native");

    let explicit = Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .args(["check", "--repo"])
        .arg(fixture.repo())
        .args([
            "--providers",
            "node-native",
            "--roots",
            "services/b",
            "--allow-unsandboxed-native",
            "--json",
            "--advisory",
        ])
        .env("XDG_CACHE_HOME", fixture.cache())
        .output()
        .unwrap();
    assert!(!explicit.status.success());
    assert!(
        String::from_utf8_lossy(&explicit.stderr)
            .contains("contains no files supported by the selected providers")
    );
}

#[test]
fn local_native_host_applies_fast_configuration_and_runs_native_with_it_present() {
    let fixture = RepositoryFixture::new(&[("Cargo.toml", MANIFEST), ("src/lib.rs", CLEAN_SOURCE)]);
    fixture.write(
        ".opcore.json",
        r#"{"schemaVersion":1,"verify":{"maxParameters":1}}"#,
    );
    fixture.write(
        "src/lib.rs",
        "pub fn answer(a: u32, b: u32) -> u32 { a + b }\n",
    );

    let output = run_local_host(&fixture);
    let report = support::json(&output);
    assert!(output.status.success(), "{report}");
    assert_eq!(report["decision"], "deny");
    let providers = report["providers"].as_array().unwrap();
    let fast = providers.iter().find(|run| run["id"] == "opcore").unwrap();
    let native = providers
        .iter()
        .find(|run| run["id"] == "opcore-rust-native")
        .unwrap();
    assert_eq!(
        fast["assessment"]["diagnostics"].as_array().unwrap().len(),
        1
    );
    assert_eq!(native["assessment"]["status"], "complete");
    assert_eq!(native["assessment"]["diagnostics"], json!([]));
}

fn run_configured_workflow(
    fixture: &RepositoryFixture,
    workflow: &str,
    tool: (&str, &Path),
) -> Output {
    let mut command = Command::new(assert_cmd::cargo::cargo_bin!("opcore"));
    command
        .args(["run", workflow, "--repo"])
        .arg(fixture.repo());
    command.args(["--json", "--allow-unsandboxed-native"]);
    if workflow == "ci" {
        command.args(["--base", "HEAD"]);
    }
    command
        .env(tool.0, tool.1)
        .env("XDG_CACHE_HOME", fixture.cache());
    command.output().unwrap()
}

#[test]
fn node_workflow_uses_configured_project_and_staged_override() {
    let fixture = node_project_fixture();
    fixture.write(
        "apps/web/src/index.ts",
        "export const value: string = \"clean\";\n",
    );
    fixture.write(
        ".opcore.json",
        r#"{
        "schemaVersion":1,
        "verify":{"maxParameters":3},
        "targets":{"exclude":["apps/legacy"]},
        "providers":{"node-native":{"roots":["apps/web"]}},
        "workflows":{"pre-commit":{"native":["node-native"]},"ci":{"native":["node-native"]}}
    }"#,
    );
    fixture.write("apps/legacy/broken.ts", "export const = ;\n");
    support::git(fixture.repo(), &["add", "."]);
    support::git(
        fixture.repo(),
        &["commit", "-qm", "configured node workflows"],
    );
    fixture.write(".opcore.json", "invalid unstaged settings");
    let tools = tempfile::tempdir().unwrap();
    let npm = tools.path().join("npm");
    fake_npm(&npm);
    for workflow in ["pre-commit", "ci"] {
        let output = run_configured_workflow(&fixture, workflow, ("OPCORE_NPM", &npm));
        let report = support::json(&output);
        assert!(output.status.success(), "{report}");
        let native = &report["native"]["providers"][0];
        assert_eq!(native["root"], "apps/web");
        assert_eq!(native["assessment"]["status"], "complete");
        assert_eq!(
            report["configuration"]["effective"]["verify"]["maxParameters"],
            3
        );
        assert!(!fixture.repo().join("apps/web/node_modules").exists());
    }
}

#[test]
fn python_workflow_replaces_provider_roots_and_keeps_exclusions() {
    let fixture = RepositoryFixture::new(&[
        ("services/python/pyproject.toml", "[tool.pyright]\n"),
        ("services/python/app.py", "value: str = \"clean\"\n"),
        ("services/legacy/app.py", "value: str = BROKEN\n"),
        (
            ".opcore.json",
            r#"{
            "schemaVersion":1,
            "targets":{"exclude":["services/legacy"]},
            "providers":{"python-native":{"roots":["services/legacy"]}},
            "workflows":{"ci":{
                "native":["python-native"],
                "providers":{"python-native":{"roots":["services/python"]}}
            }}
        }"#,
        ),
    ]);
    let tools = tempfile::tempdir().unwrap();
    let pyright = tools.path().join("pyright");
    fake_pyright(&pyright);
    let output = run_configured_workflow(&fixture, "ci", ("OPCORE_PYRIGHT", &pyright));
    let report = support::json(&output);
    assert!(output.status.success(), "{report}");
    assert_eq!(report["native"]["providers"][0]["root"], "services/python");
    assert_eq!(
        report["native"]["providers"][0]["assessment"]["status"],
        "complete"
    );
    assert_eq!(report["verify"]["coverage"]["filesCovered"], 1);
}

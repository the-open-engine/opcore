#![cfg(unix)]

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

use serde_json::Value;

mod support;
use support::RepositoryFixture;

fn git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn initialize(repo: &Path) {
    fs::create_dir_all(repo.join("src")).unwrap();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.name", "Test"]);
    git(repo, &["config", "user.email", "test@example.com"]);
    fs::write(repo.join("src/a.ts"), "export const first = 1;\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "initial"]);
}

fn repository_and_cache(root: &Path) -> (PathBuf, PathBuf) {
    let repo = root.join("repo");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);
    (repo, root.join("cache"))
}

fn run(repo: &Path, cache: &Path, args: &[&str]) -> Output {
    Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .args(args)
        .env("XDG_CACHE_HOME", cache)
        .env("HOME", cache.with_file_name("agent-home"))
        .env_remove("CODEX_HOME")
        .env_remove("CLAUDE_CONFIG_DIR")
        .current_dir(repo)
        .output()
        .unwrap()
}

fn json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap()
}

fn doctor_row<'a>(report: &'a Value, id: &str) -> &'a Value {
    report["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == id)
        .unwrap()
}

fn configure_agent_hook(home: &Path, agent: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let root = home.join(format!(".{agent}"));
    let config = root.join(if agent == "codex" {
        "hooks.json"
    } else {
        "settings.json"
    });
    let receipt = root.join("opcore/hook-install.json");
    let output = Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .args(["configure-hook", "--agent", agent, "--config"])
        .arg(&config)
        .arg("--receipt")
        .arg(&receipt)
        .arg("--binary")
        .arg(assert_cmd::cargo::cargo_bin!("opcore"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    (config, receipt)
}

#[test]
fn strict_policy_drives_verify_and_sense_and_binds_freshness() {
    let temp = tempfile::tempdir().unwrap();
    let (repo, cache) = repository_and_cache(temp.path());
    fs::write(
        repo.join(".opcore.json"),
        r#"{"schemaVersion":1,"verify":{"maxParameters":1},"sense":{"maxModuleExports":0}}"#,
    )
    .unwrap();
    fs::write(
        repo.join("src/a.ts"),
        "export const first = 1;\nexport function added(a, b) { return a + b; }\n",
    )
    .unwrap();

    let check = run(&repo, &cache, &["check", "--changed", "--json"]);
    assert!(!check.status.success());
    let assessment = json(&check);
    assert!(
        assessment["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| {
                item["ruleId"] == "complexity.max-parameters"
                    && item["message"].as_str().unwrap().contains("maximum is 1")
            })
    );
    let valid_as_of: Value =
        serde_json::from_str(assessment["validAsOf"].as_str().unwrap()).unwrap();
    assert_eq!(valid_as_of["kind"], "opcore-local");
    assert!(
        valid_as_of["policy"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );

    let sense = run(&repo, &cache, &["sense", "--json"]);
    assert!(!sense.status.success());
    let report = json(&sense);
    assert_eq!(report["effectivePolicy"]["maxModuleExports"], 0);
    assert!(
        report["interfaceFindings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| { item["code"] == "sense.interface.module_exports" && item["limit"] == 0 })
    );
}

#[test]
fn status_and_doctor_are_read_only_and_machine_readable() {
    let temp = tempfile::tempdir().unwrap();
    let (repo, cache) = repository_and_cache(temp.path());

    let status = run(&repo, &cache, &["status", "--json"]);
    assert!(status.status.success());
    let status = json(&status);
    assert_eq!(status["schema"], "opcore.status.v2");
    assert_eq!(status["status"], "fast_check_ready");
    assert!(
        status["buildFingerprint"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert_eq!(status["policy"]["state"], "default");
    assert_eq!(status["runtime"]["persistentGraph"], false);
    assert!(!repo.join(".opcore").exists());

    let doctor = run(&repo, &cache, &["doctor", "--json"]);
    assert!(doctor.status.success());
    let doctor = json(&doctor);
    assert_eq!(doctor["schema"], "opcore.doctor.v2");
    assert_eq!(doctor["status"], "fast_check_ready");
    assert_eq!(doctor_row(&doctor, "codex_hook")["status"], "skip");
    assert_eq!(doctor_row(&doctor, "claude_hook")["status"], "skip");
    assert!(
        doctor["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|check| check["id"] == "rust_native_runtime")
    );
    assert!(
        doctor["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|check| check["id"] == "node_native_runtime")
    );

    let bad_cargo = Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .args(["doctor", "--repo"])
        .arg(&repo)
        .arg("--json")
        .env("XDG_CACHE_HOME", &cache)
        .env("OPCORE_CARGO", "/missing/opcore-cargo")
        .output()
        .unwrap();
    assert!(!bad_cargo.status.success());
    assert!(
        json(&bad_cargo)["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|check| check["id"] == "rust_native_tool" && check["status"] == "fail")
    );

    let bad_mypy = Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .args(["doctor", "--repo"])
        .arg(&repo)
        .arg("--json")
        .env("XDG_CACHE_HOME", &cache)
        .env_remove("OPCORE_PYRIGHT")
        .env("OPCORE_MYPY", "relative-mypy")
        .env("PATH", "/usr/bin:/bin")
        .output()
        .unwrap();
    assert!(!bad_mypy.status.success());
    assert!(
        json(&bad_mypy)["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|check| check["id"] == "python_native_checker" && check["status"] == "fail")
    );
    assert!(
        !cache.exists(),
        "read-only commands must not create cache state"
    );
}

#[test]
fn doctor_checks_owned_hook_configuration_without_claiming_host_activation() {
    let fixture = RepositoryFixture::new(&[("src/a.ts", "export const first = 1;\n")]);
    let home = fixture.cache().with_file_name("agent-home");
    for agent in ["codex", "claude"] {
        let (config, receipt) = configure_agent_hook(&home, agent);
        let original = fs::read(&config).unwrap();
        let owned = fs::read(&receipt).unwrap();
        let id = format!("{agent}_hook");
        let healthy = run(fixture.repo(), fixture.cache(), &["doctor", "--json"]);
        assert!(healthy.status.success());
        let healthy = json(&healthy);
        assert_eq!(doctor_row(&healthy, &id)["status"], "pass");
        assert!(
            doctor_row(&healthy, &id)["detail"]
                .as_str()
                .unwrap()
                .contains("unverified")
        );
        assert_eq!(fs::read(&config).unwrap(), original);
        assert_eq!(fs::read(&receipt).unwrap(), owned);

        fs::write(&config, "{broken JSON").unwrap();
        let malformed = run(fixture.repo(), fixture.cache(), &["doctor", "--json"]);
        assert!(!malformed.status.success());
        assert_eq!(doctor_row(&json(&malformed), &id)["status"], "fail");
        assert!(
            doctor_row(&json(&malformed), &id)["detail"]
                .as_str()
                .unwrap()
                .contains("rerun installation")
        );
        assert_eq!(fs::read_to_string(&config).unwrap(), "{broken JSON");
        fs::write(&config, &original).unwrap();

        let mut duplicated: Value = serde_json::from_slice(&original).unwrap();
        let hooks = duplicated["hooks"]["PostToolUse"][0]["hooks"]
            .as_array_mut()
            .unwrap();
        hooks.push(hooks[0].clone());
        fs::write(&config, serde_json::to_vec(&duplicated).unwrap()).unwrap();
        let duplicate = run(fixture.repo(), fixture.cache(), &["doctor", "--json"]);
        assert!(!duplicate.status.success());
        assert!(
            doctor_row(&json(&duplicate), &id)["detail"]
                .as_str()
                .unwrap()
                .contains("duplicated")
        );
        fs::write(&config, original).unwrap();
    }
    assert!(!fixture.cache().exists());
}

#[test]
fn doctor_identifies_interrupted_or_missing_owned_hook_installations() {
    let fixture = RepositoryFixture::new(&[("src/a.ts", "export const first = 1;\n")]);
    let home = fixture.cache().with_file_name("agent-home");
    let (config, receipt) = configure_agent_hook(&home, "codex");
    let install = receipt.with_file_name("install.receipt");
    fs::write(&install, "opcore.install.v1\nbinary historical\n").unwrap();
    assert!(
        run(fixture.repo(), fixture.cache(), &["doctor", "--json"])
            .status
            .success()
    );
    for enrollment in ["hooks pending\n", "hooks no\n", "hooks yes\nhooks no\n"] {
        fs::write(&install, enrollment).unwrap();
        let report = run(fixture.repo(), fixture.cache(), &["doctor", "--json"]);
        assert!(!report.status.success());
        assert_eq!(doctor_row(&json(&report), "codex_hook")["status"], "fail");
        assert_eq!(fs::read_to_string(&install).unwrap(), enrollment);
    }
    fs::write(&install, "hooks yes\n").unwrap();
    fs::remove_file(&config).unwrap();
    let missing_config = run(fixture.repo(), fixture.cache(), &["doctor", "--json"]);
    assert!(!missing_config.status.success());
    assert!(
        doctor_row(&json(&missing_config), "codex_hook")["detail"]
            .as_str()
            .unwrap()
            .contains("config is missing")
    );
    fs::remove_file(&receipt).unwrap();
    let missing_receipt = run(fixture.repo(), fixture.cache(), &["doctor", "--json"]);
    assert!(!missing_receipt.status.success());
    assert!(
        doctor_row(&json(&missing_receipt), "codex_hook")["detail"]
            .as_str()
            .unwrap()
            .contains("ownership receipt is missing")
    );
    assert!(!config.exists());
    assert!(!receipt.exists());
    assert!(!fixture.cache().exists());
}

#[test]
fn rules_are_read_only_and_machine_readable() {
    let fixture = RepositoryFixture::new(&[("src/a.ts", "export const first = 1;\n")]);
    let repo = fixture.repo();
    let cache = fixture.cache();

    let rules = run(repo, cache, &["rules"]);
    assert!(rules.status.success());
    let rules = json(&rules);
    assert_eq!(rules["schema"], "opcore.rules.v1");
    assert_eq!(rules["policy"]["path"], ".opcore.json");
    let verify = rules["verify"].as_array().unwrap();
    assert_eq!(
        rules["native"],
        serde_json::json!([
            {
                "id": "opcore-rust-native/cargo-check",
                "family": "native",
                "languages": ["rust"],
                "intervention": "finding",
                "configurableLimit": null
            },
            {
                "id": "opcore-node-native/typescript-check",
                "family": "native",
                "languages": ["javascript", "typescript"],
                "intervention": "finding",
                "configurableLimit": null
            },
            {
                "id": "opcore-python-native/type-check",
                "family": "native",
                "languages": ["python"],
                "intervention": "finding",
                "configurableLimit": null
            }
        ])
    );
    let verify_languages = |id: &str| {
        verify.iter().find(|rule| rule["id"] == id).unwrap()["languages"]
            .as_array()
            .unwrap()
            .clone()
    };
    assert!(
        verify_languages("hcl.syntax").contains(&Value::from("hcl"))
            && verify_languages("shell.syntax").contains(&Value::from("shell"))
            && verify_languages("protobuf.syntax").contains(&Value::from("protobuf"))
    );
    assert!(
        !verify_languages("complexity.max-cyclomatic-complexity").contains(&Value::from("hcl"))
    );
    let sense = rules["sense"].as_array().unwrap();
    let languages = |id: &str| {
        sense.iter().find(|rule| rule["id"] == id).unwrap()["languages"]
            .as_array()
            .unwrap()
            .clone()
    };
    assert!(!languages("sense.runtime_cycle").contains(&Value::from("rust")));
    assert!(languages("sense.duplication.identical_file").contains(&Value::from("shell")));
    assert!(!languages("sense.duplication.callable_body").contains(&Value::from("hcl")));
    assert!(languages("sense.interface.dependency_targets").contains(&Value::from("rust")));
    assert!(languages("sense.runtime_cycle").contains(&Value::from("go")));
    assert!(languages("sense.interface.module_exports").contains(&Value::from("go")));
    assert!(languages("sense.interface.shape_members").contains(&Value::from("go")));
    assert!(!languages("sense.interface.edge_selectors").contains(&Value::from("go")));
    assert!(languages("sense.documentation.missing_binding").contains(&Value::from("rust")));
    assert!(
        !cache.exists(),
        "read-only commands must not create cache state"
    );
}

#[test]
fn malformed_policy_fails_closed_and_doctor_identifies_it() {
    let temp = tempfile::tempdir().unwrap();
    let (repo, cache) = repository_and_cache(temp.path());
    fs::write(
        repo.join(".opcore.json"),
        r#"{"schemaVersion":1,"verify":{},"verify":{}}"#,
    )
    .unwrap();

    let check = run(&repo, &cache, &["check", "--changed", "--json"]);
    assert!(!check.status.success());
    let assessment = json(&check);
    assert_eq!(assessment["status"], "incomplete");
    assert!(
        assessment["coverage"]["gaps"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("duplicate JSON object key")
    );

    let doctor = run(&repo, &cache, &["doctor", "--json"]);
    assert!(!doctor.status.success());
    let report = json(&doctor);
    assert_eq!(report["status"], "needs_attention");
    assert!(
        report["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|check| { check["id"] == "policy" && check["status"] == "fail" })
    );
}

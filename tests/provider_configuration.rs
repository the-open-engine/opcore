use std::{fs, process::Output};

use serde_json::{Value, json};

mod support;

use support::{RepositoryFixture, git, opcore_json};

const SOURCE: &str = "export function sum(a: number, b: number, c: number) { return a + b + c; }\n";
const CONFIG: &str = r#"{
  "schemaVersion": 1,
  "verify": {"maxParameters": 2},
  "workflows": {"post-edit": {"verify": {"maxParameters": 6}}}
}"#;

fn provider(fixture: &RepositoryFixture, options: &[&str]) -> Output {
    let mut arguments = vec!["--providers", "fast"];
    arguments.extend_from_slice(options);
    opcore_json(fixture, "check", &arguments)
}

fn assessment(output: &Output) -> Value {
    support::json(output)["providers"][0]["assessment"].clone()
}

#[test]
fn direct_check_reports_configuration_state_view_and_origins() {
    let fixture = RepositoryFixture::new(&[("src/main.ts", "export const ready = true;\n")]);

    let default = opcore_json(&fixture, "check", &["--all"]);
    let default = support::json(&default);
    assert_eq!(default["configuration"]["state"], "default");
    assert_eq!(default["configuration"]["view"]["kind"], "worktree");
    assert_eq!(
        default["configuration"]["origins"]["/verify/maxParameters"],
        "default"
    );

    fixture.write(
        ".opcore.json",
        r#"{
          "schemaVersion": 1,
          "verify": {"maxParameters": 7},
          "workflows": {"post-edit": {"verify": {"maxParameters": 5}}}
        }"#,
    );
    let worktree = opcore_json(&fixture, "check", &["--all", "--workflow", "post-edit"]);
    let worktree = support::json(&worktree);
    assert_eq!(worktree["configuration"]["state"], "configured");
    assert_eq!(worktree["configuration"]["view"]["kind"], "worktree");
    assert_eq!(
        worktree["configuration"]["effective"]["verify"]["maxParameters"],
        5
    );
    assert_eq!(
        worktree["configuration"]["origins"]["/verify/maxParameters"],
        "workflow:post-edit"
    );
    assert!(worktree["configuration"]["digest"].as_str().is_some());

    git(fixture.repo(), &["add", ".opcore.json"]);
    let staged = opcore_json(&fixture, "check", &["--staged", "--all"]);
    assert_eq!(
        support::json(&staged)["configuration"]["view"]["kind"],
        "index"
    );

    git(fixture.repo(), &["commit", "-qm", "configure"]);
    let tree = opcore_json(&fixture, "check", &["--tree", "HEAD", "--all"]);
    let tree = support::json(&tree);
    assert_eq!(tree["configuration"]["view"]["kind"], "tree");
    assert_eq!(tree["configuration"]["view"]["ref"], "HEAD");

    let hosted = provider(&fixture, &["--all", "--workflow", "post-edit"]);
    let hosted = support::json(&hosted);
    for field in ["state", "view", "digest", "effective", "origins"] {
        assert_eq!(
            hosted["configuration"][field],
            worktree["configuration"][field]
        );
    }
}

#[test]
fn direct_and_asp_fast_share_workflow_thresholds() {
    let fixture = RepositoryFixture::new(&[("src/main.ts", SOURCE), (".opcore.json", CONFIG)]);
    for (workflow, passes) in [("post-edit", true), ("pre-commit", false)] {
        let direct = opcore_json(&fixture, "check", &["--all", "--workflow", workflow]);
        let asp = provider(&fixture, &["--all", "--workflow", workflow]);
        assert_eq!(
            direct.status.success(),
            passes,
            "{}",
            String::from_utf8_lossy(&direct.stderr)
        );
        assert_eq!(
            asp.status.success(),
            passes,
            "{}",
            String::from_utf8_lossy(&asp.stderr)
        );
        let direct = support::json(&direct);
        let asp = assessment(&asp);
        assert_eq!(
            direct["diagnostics"].as_array().unwrap().len(),
            asp["diagnostics"].as_array().unwrap().len()
        );
        if !passes {
            assert!(
                asp["diagnostics"][0]["message"]
                    .as_str()
                    .unwrap()
                    .contains("maximum is 2")
            );
        }
    }
}

#[test]
fn staged_and_committed_provider_checks_use_configuration_from_that_view() {
    let fixture = RepositoryFixture::new(&[("src/main.ts", SOURCE), (".opcore.json", CONFIG)]);
    fixture.write(
        ".opcore.json",
        r#"{"schemaVersion":1,"verify":{"maxParameters":8}}"#,
    );
    for selection in [&["--staged", "--all"][..], &["--tree", "HEAD", "--all"][..]] {
        let output = provider(&fixture, selection);
        assert!(!output.status.success());
        assert_eq!(
            assessment(&output)["diagnostics"].as_array().unwrap().len(),
            1
        );
    }
    assert!(provider(&fixture, &["--all"]).status.success());
    fixture.write(".opcore.json", "invalid unstaged configuration");
    let staged = provider(&fixture, &["--staged", "--all"]);
    assert_eq!(support::json(&staged)["decision"], "deny");
    let committed = provider(&fixture, &["--tree", "HEAD", "--all"]);
    assert_eq!(support::json(&committed)["decision"], "deny");
}

#[test]
fn excluded_fast_subtrees_do_not_consume_capture_bounds_or_hide_prefix_siblings() {
    let fixture = RepositoryFixture::new(&[
        ("src/main.ts", "export const answer = 42;\n"),
        (
            ".opcore.json",
            r#"{"schemaVersion":1,"targets":{"exclude":["vendor"]}}"#,
        ),
    ]);
    fixture.write("vendor/large.ts", &"x".repeat(5 * 1024 * 1024));
    fixture.write("vendor/component.vue", "<template />");
    let output = provider(&fixture, &["--all"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(assessment(&output)["evidence"][0]["data"]["filesRead"], 1);
    fixture.write("vendor-tools/main.ts", "export const = ;\n");
    let output = provider(&fixture, &["--all"]);
    assert!(!output.status.success());
    assert_eq!(
        assessment(&output)["diagnostics"][0]["location"]["path"],
        "vendor-tools/main.ts"
    );
}

fn rust_workspace_fixture() -> RepositoryFixture {
    RepositoryFixture::new(&[
        (
            "Cargo.toml",
            "[workspace]\nmembers = [\"crates/good\", \"crates/dependency\"]\nresolver = \"2\"\n",
        ),
        (
            "crates/good/Cargo.toml",
            "[package]\nname = \"selected-good\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        ),
        ("crates/good/src/lib.rs", "pub fn answer() -> u32 { 42 }\n"),
        (
            "crates/dependency/Cargo.toml",
            "[package]\nname = \"selected-dependency\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        ),
        (
            "crates/dependency/src/lib.rs",
            "pub fn answer() -> u32 { \"broken\" }\n",
        ),
        (
            ".opcore.json",
            r#"{
            "schemaVersion":1,
            "targets":{"exclude":["crates/dependency"]},
            "providers":{"rust-native":{"roots":["crates/good"]}}
        }"#,
        ),
    ])
}

#[test]
fn rust_configured_roots_keep_excluded_dependency_context() {
    let fixture = rust_workspace_fixture();
    let options = [
        "--providers",
        "rust-native",
        "--all",
        "--allow-unsandboxed-native",
    ];
    let output = opcore_json(&fixture, "check", &options);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        support::json(&output)["providers"][0]["root"],
        "crates/good"
    );
    assert_eq!(support::json(&output)["providers"][0]["context"], ".");
    assert!(!fixture.repo().join("Cargo.lock").exists());

    fixture.write(
        "crates/good/Cargo.toml",
        concat!(
            "[package]\nname = \"selected-good\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
            "[dependencies]\nselected-dependency = { path = \"../dependency\" }\n"
        ),
    );
    let output = opcore_json(&fixture, "check", &options);
    assert!(!output.status.success());
    assert_eq!(support::json(&output)["decision"], "deny");
    let diagnostics = assessment(&output)["diagnostics"].clone();
    assert!(
        diagnostics
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| { diagnostic["location"]["path"] == "crates/dependency/src/lib.rs" })
    );
    assert!(!fixture.repo().join("Cargo.lock").exists());
}

#[test]
fn native_file_exclusion_reports_recovery_and_all_excluded_roots_are_not_clean() {
    let fixture = RepositoryFixture::new(&[
        (
            "Cargo.toml",
            "[package]\nname = \"excluded-input\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        ),
        ("src/lib.rs", "pub fn answer() {}\n"),
        (
            ".opcore.json",
            r#"{"schemaVersion":1,"targets":{"exclude":["src"]}}"#,
        ),
    ]);
    let output = opcore_json(
        &fixture,
        "check",
        &[
            "--providers",
            "rust-native",
            "--all",
            "--allow-unsandboxed-native",
        ],
    );
    assert!(!output.status.success());
    assert!(
        support::json(&output)["message"]
            .as_str()
            .unwrap()
            .contains("providers.<name>.roots")
    );
    fixture.write(
        ".opcore.json",
        r#"{
        "schemaVersion":1,"targets":{"exclude":["src"]},
        "providers":{"rust-native":{"roots":["src"]}}
    }"#,
    );
    let output = opcore_json(
        &fixture,
        "check",
        &[
            "--providers",
            "rust-native",
            "--all",
            "--allow-unsandboxed-native",
        ],
    );
    assert!(!output.status.success());
    assert_eq!(support::json(&output)["decision"], "indeterminate");
    assert_eq!(
        support::json(&output)["providers"][0]["skipped"],
        "excluded by targets.exclude"
    );
}

#[test]
fn empty_workflow_provider_roots_do_not_revert_to_the_repository_root() {
    let fixture = RepositoryFixture::new(&[
        ("app.py", "value: int = 1\n"),
        (
            ".opcore.json",
            r#"{
            "schemaVersion":1,
            "providers":{"python-native":{"roots":["."]}},
            "workflows":{"ci":{"providers":{"python-native":{"roots":[]}}}}
        }"#,
        ),
    ]);
    let output = opcore_json(
        &fixture,
        "check",
        &[
            "--providers",
            "python-native",
            "--all",
            "--workflow",
            "ci",
            "--allow-unsandboxed-native",
        ],
    );
    let report = support::json(&output);
    assert_eq!(report["decision"], "indeterminate");
    assert!(
        report["message"]
            .as_str()
            .unwrap()
            .contains("roots is empty")
    );
    assert!(!output.status.success());
}

#[test]
fn committed_provider_base_does_not_read_dirty_checkout_sources() {
    let fixture = RepositoryFixture::new(&[("src/main.ts", "export const answer = 42;\n")]);
    fixture.write("src/main.ts", SOURCE);
    fixture.write(".opcore.json", CONFIG);
    git(fixture.repo(), &["add", "."]);
    git(fixture.repo(), &["commit", "-qm", "stricter target"]);
    fixture.write("src/main.ts", "invalid worktree syntax !");
    fs::remove_file(fixture.repo().join(".opcore.json")).unwrap();
    let output = provider(&fixture, &["--tree", "HEAD", "--base", "HEAD~1"]);
    assert_eq!(support::json(&output)["decision"], "deny");
    let diagnostics = assessment(&output)["diagnostics"].clone();
    assert_eq!(diagnostics.as_array().unwrap().len(), 1);
    assert!(
        diagnostics[0]["message"]
            .as_str()
            .unwrap()
            .contains("maximum is 2")
    );
    assert_eq!(
        fs::read_to_string(fixture.repo().join("src/main.ts")).unwrap(),
        "invalid worktree syntax !"
    );
    assert_eq!(support::json(&output)["comparison"], json!("introduced"));
}

#[test]
fn rust_native_precommit_and_ci_workflows_run_configured_package_from_git_objects() {
    let fixture = rust_workspace_fixture();
    fixture.write(
        ".opcore.json",
        r#"{
        "schemaVersion":1,
        "verify":{"maxParameters":1},
        "targets":{"exclude":["crates/dependency"]},
        "providers":{"rust-native":{"roots":["crates/good"]}},
        "workflows":{"pre-commit":{"native":["rust-native"]},"ci":{"native":["rust-native"]}}
    }"#,
    );
    git(fixture.repo(), &["add", "."]);
    git(
        fixture.repo(),
        &["commit", "-qm", "configured Rust workflows"],
    );
    fixture.write("crates/good/src/lib.rs", "invalid dirty source !");
    fixture.write(".opcore.json", "invalid dirty settings");
    for workflow in ["pre-commit", "ci"] {
        let mut options = vec![workflow, "--allow-unsandboxed-native"];
        if workflow == "ci" {
            options.extend(["--base", "HEAD"]);
        }
        let output = opcore_json(&fixture, "run", &options);
        let report = support::json(&output);
        assert!(output.status.success(), "{report}");
        assert_eq!(report["native"]["providers"][0]["root"], "crates/good");
        assert_eq!(report["native"]["decision"], "allow");
        assert_eq!(
            report["configuration"]["effective"]["verify"]["maxParameters"],
            1
        );
        assert!(!fixture.repo().join("Cargo.lock").exists());
    }
}

#[test]
fn doctor_checks_native_project_controls_without_reading_source_or_creating_cache() {
    let fixture = RepositoryFixture::new(&[
        (
            "apps/web/package.json",
            r#"{"name":"doctor-fixture","private":true}"#,
        ),
        ("apps/web/tsconfig.json", "{}\n"),
        ("apps/web/src/main.ts", "export const answer = 42;\n"),
        (
            ".opcore.json",
            r#"{
            "schemaVersion":1,"native":["node-native"],
            "providers":{"node-native":{"roots":["apps/web"]}}
        }"#,
        ),
    ]);
    let inspect = |options: &[&str]| support::json(&opcore_json(&fixture, "doctor", options));
    let project = |report: &Value| {
        report["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["id"] == "node_native_project")
            .unwrap()
            .clone()
    };
    let missing = project(&inspect(&[]));
    assert_eq!(missing["status"], "fail");
    assert!(missing["detail"].as_str().unwrap().contains("npm lockfile"));

    fixture.write("apps/web/package-lock.json", "{}\n");
    fixture.write("apps/web/src/main.ts", &"invalid source".repeat(500_000));
    let present = inspect(&[]);
    assert_eq!(present["sourceEvaluated"], false);
    assert_eq!(project(&present)["status"], "pass");
    assert!(
        project(&present)["detail"]
            .as_str()
            .unwrap()
            .contains("setup inspection only")
    );
    assert_eq!(project(&inspect(&["--tree", "HEAD"]))["status"], "fail");
    git(fixture.repo(), &["add", "apps/web/package-lock.json"]);
    fs::remove_file(fixture.repo().join("apps/web/package-lock.json")).unwrap();
    assert_eq!(project(&inspect(&[]))["status"], "fail");
    assert_eq!(project(&inspect(&["--staged"]))["status"], "pass");
    assert_eq!(
        project(&inspect(&["--workflow", "pre-commit"]))["status"],
        "pass"
    );
    assert!(!fixture.cache().exists());
}

#[cfg(unix)]
#[test]
fn doctor_uses_project_python_interpreters_when_path_has_no_python() {
    use std::{
        os::unix::fs::{PermissionsExt as _, symlink},
        process::Command,
    };

    let fixture = RepositoryFixture::new(&[
        ("service/src/app.py", "answer = 42\n"),
        ("service/pyproject.toml", ""),
        (
            ".opcore.json",
            r#"{"schemaVersion":1,"native":["python-native"],"providers":{"python-native":{"roots":["service/src"]}}}"#,
        ),
    ]);
    let tools = tempfile::tempdir().unwrap();
    let git_program = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|directory| directory.join("git"))
        .find(|path| path.is_file())
        .unwrap();
    symlink(git_program, tools.path().join("git")).unwrap();
    let probe = tools.path().join("checker");
    fs::write(&probe, "#!/bin/sh\n: > \"$OPCORE_DOCTOR_PROBE\"\nexit 97\n").unwrap();
    fs::set_permissions(&probe, fs::Permissions::from_mode(0o700)).unwrap();
    let project = fixture.repo().join("service");
    fs::create_dir_all(project.join(".venv/bin")).unwrap();
    symlink(&probe, project.join(".venv/bin/python")).unwrap();
    let command = || {
        let mut command = Command::new(assert_cmd::cargo::cargo_bin!("opcore"));
        command
            .args(["doctor", "--json", "--repo"])
            .arg(fixture.repo())
            .env_clear()
            .env("PATH", tools.path())
            .env("HOME", tools.path().join("agent-home"))
            .env("XDG_CACHE_HOME", fixture.cache())
            .env("OPCORE_PYRIGHT", &probe)
            .env("OPCORE_DOCTOR_PROBE", tools.path().join("executed"));
        command
    };
    let inspect = |output: Output, status: &str| {
        let report = support::json(&output);
        let project = report["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == "python_native_project")
            .unwrap();
        assert_eq!(project["status"], status, "{report}");
        assert_eq!(output.status.success(), status == "pass", "{report}");
        project["detail"].as_str().unwrap().to_owned()
    };
    assert!(inspect(command().output().unwrap(), "pass").contains("project-dot-venv"));

    let active = project.join("active-env");
    fs::rename(project.join(".venv"), &active).unwrap();
    let active_output = command().env("VIRTUAL_ENV", &active).output().unwrap();
    assert!(inspect(active_output, "pass").contains("active-project-venv"));
    let repository_alias = tools.path().join("repository-alias");
    symlink(fixture.repo(), &repository_alias).unwrap();
    let aliased = command()
        .env("VIRTUAL_ENV", repository_alias.join("service/active-env"))
        .output()
        .unwrap();
    assert!(inspect(aliased, "pass").contains("active-project-venv"));
    assert!(inspect(command().output().unwrap(), "fail").contains("requires a Python interpreter"));

    fs::create_dir(tools.path().join("bin")).unwrap();
    symlink(&probe, tools.path().join("bin/python")).unwrap();
    let external = command().env("VIRTUAL_ENV", tools.path()).output().unwrap();
    inspect(external, "fail");
    let escaping = project.join("external-env");
    symlink(tools.path(), &escaping).unwrap();
    let escaped = command().env("VIRTUAL_ENV", &escaping).output().unwrap();
    inspect(escaped, "fail");
    let explicit = command()
        .env("OPCORE_PYTHON", tools.path().join("bin/python"))
        .output()
        .unwrap();
    assert!(inspect(explicit, "pass").contains("explicit"));
    assert!(!tools.path().join("executed").exists());
    assert!(!fixture.cache().exists());
}

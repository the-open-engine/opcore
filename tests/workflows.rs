#![cfg(unix)]

use std::{fs, process::Command};

use serde_json::{Value, json};

mod support;
use support::{RepositoryFixture, git, json as report, opcore};

fn run(fixture: &RepositoryFixture, workflow: &str, arguments: &[&str], accepted: bool) -> Value {
    let mut options = vec![workflow, "--json"];
    options.extend_from_slice(arguments);
    let output = opcore(fixture.repo(), fixture.cache(), "run", &options);
    assert_eq!(
        output.status.success(),
        accepted,
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    report(&output)
}

fn configure(fixture: &RepositoryFixture, value: &Value) {
    fixture.write(".opcore.json", &serde_json::to_string(value).unwrap());
}

fn hook(fixture: &RepositoryFixture) -> std::process::Output {
    Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .arg("agent-gate")
        .current_dir(fixture.repo())
        .env("XDG_CACHE_HOME", fixture.cache())
        .output()
        .unwrap()
}

#[test]
fn workflow_overrides_are_shared_by_hook_manual_check_and_full_staged_gate() {
    let fixture = RepositoryFixture::new(&[("src/a.ts", "export const initial = 1;\n")]);
    configure(
        &fixture,
        &json!({
            "schemaVersion": 1,
            "verify": {"maxParameters": 1},
            "workflows": {"post-edit": {"verify": {"maxParameters": 3}}}
        }),
    );
    fixture.write("src/a.ts", "export function add(a, b) { return a + b; }\n");
    let post = run(&fixture, "post-edit", &[], true);
    assert_eq!(post["verify"]["status"], "clean");

    let manual = opcore(
        fixture.repo(),
        fixture.cache(),
        "check",
        &["--all", "--json"],
    );
    assert!(!manual.status.success());
    let hook = hook(&fixture);
    assert!(
        hook.status.success(),
        "{}",
        String::from_utf8_lossy(&hook.stderr)
    );

    git(fixture.repo(), &["add", "."]);
    // An unstaged relaxation must not affect the commit gate.
    configure(
        &fixture,
        &json!({"schemaVersion":1,"verify":{"maxParameters":9}}),
    );
    let result = run(&fixture, "pre-commit", &[], false);
    assert_eq!(
        result["configuration"]["effective"]["verify"]["maxParameters"],
        1
    );
    assert_eq!(
        result["verify"]["diagnostics"][0]["ruleId"],
        "complexity.max-parameters"
    );
    assert_eq!(result["configuration"]["view"]["kind"], "index");
}

#[test]
fn exclusions_replace_per_workflow_and_match_whole_path_segments() {
    let fixture = RepositoryFixture::new(&[("src/a.ts", "export const first = 1;\n")]);
    configure(
        &fixture,
        &json!({
            "schemaVersion": 1,
            "targets": {"exclude": ["legacy"]},
            "workflows": {"pre-commit": {"targets": {"exclude": []}}}
        }),
    );
    fixture.write("legacy/broken.ts", "export const = ;\n");
    let post = run(&fixture, "post-edit", &[], true);
    assert_eq!(post["verify"]["status"], "not_checked");

    git(fixture.repo(), &["add", "."]);
    let staged = run(&fixture, "pre-commit", &[], false);
    assert_eq!(staged["verify"]["status"], "findings");

    fixture.write("legacy-utils/broken.ts", "export const = ;\n");
    let post = run(&fixture, "post-edit", &[], false);
    assert!(
        post["verify"]["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["path"] == "legacy-utils/broken.ts")
    );
}

#[test]
fn ci_checks_committed_source_and_configuration_and_requires_its_base() {
    let fixture = RepositoryFixture::new(&[("src/a.py", "initial = 1\n")]);
    let base = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(fixture.repo())
        .output()
        .unwrap();
    let base = String::from_utf8(base.stdout).unwrap();
    configure(
        &fixture,
        &json!({"schemaVersion":1,"verify":{"maxParameters":1}}),
    );
    fixture.write("src/a.py", "def add(a, b):\n    return a + b\n");
    git(fixture.repo(), &["add", "."]);
    git(fixture.repo(), &["commit", "-qm", "candidate"]);
    fixture.write("src/a.py", "initial = 2\n");
    configure(
        &fixture,
        &json!({"schemaVersion":1,"verify":{"maxParameters":8}}),
    );
    let missing_base = run(&fixture, "ci", &[], false);
    assert!(missing_base["error"].as_str().unwrap().contains("--base"));
    let result = run(&fixture, "ci", &["--base", base.trim()], false);
    assert_eq!(result["verify"]["status"], "findings");
    assert_eq!(
        result["configuration"]["effective"]["verify"]["maxParameters"],
        1
    );
    assert_eq!(
        fs::read_to_string(fixture.repo().join("src/a.py")).unwrap(),
        "initial = 2\n"
    );
}

#[test]
fn full_commit_gate_reports_existing_findings_and_rejects_an_empty_target_set() {
    let fixture = RepositoryFixture::new(&[(
        "src/a.ts",
        "export function debt(a,b,c,d,e,f) { return a+b+c+d+e+f; }\n",
    )]);
    let staged = run(&fixture, "pre-commit", &[], false);
    assert_eq!(staged["verify"]["status"], "findings");
    configure(
        &fixture,
        &json!({"schemaVersion":1,"targets":{"exclude":["src"]}}),
    );
    git(fixture.repo(), &["add", ".opcore.json"]);
    let excluded = run(&fixture, "pre-commit", &[], false);
    assert_eq!(excluded["verify"]["status"], "unsupported");
}

#[test]
fn introduced_pre_commit_grandfathers_existing_findings_but_checks_changed_files() {
    let fixture = RepositoryFixture::new(&[(
        "legacy.ts",
        "export function legacy(a,b,c,d,e,f) { return a+b+c+d+e+f; }\n",
    )]);
    fixture.write("clean.ts", "export const clean = true;\n");
    git(fixture.repo(), &["add", "clean.ts"]);

    let full = run(&fixture, "pre-commit", &[], false);
    assert_eq!(full["comparison"], "all");
    assert_eq!(full["verify"]["status"], "findings");

    let introduced = run(
        &fixture,
        "pre-commit",
        &["--comparison", "introduced"],
        true,
    );
    assert_eq!(introduced["comparison"], "introduced");
    assert_eq!(introduced["verify"]["status"], "clean");

    fixture.write(
        "legacy.ts",
        concat!(
            "export function legacy(a,b,c,d,e,f) { return a+b+c+d+e+f; }\n",
            "export function added(a,b,c,d,e,f) { return a+b+c+d+e+f; }\n"
        ),
    );
    git(fixture.repo(), &["add", "legacy.ts"]);
    let regression = run(
        &fixture,
        "pre-commit",
        &["--comparison", "introduced"],
        false,
    );
    assert_eq!(regression["verify"]["status"], "findings");
    assert_eq!(
        regression["verify"]["diagnostics"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn introduced_ci_compares_the_target_with_the_explicit_base() {
    let fixture = RepositoryFixture::new(&[(
        "legacy.ts",
        "export function legacy(a,b,c,d,e,f) { return a+b+c+d+e+f; }\n",
    )]);
    let base = String::from_utf8(
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(fixture.repo())
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    fixture.write("clean.ts", "export const clean = true;\n");
    git(fixture.repo(), &["add", "clean.ts"]);
    git(fixture.repo(), &["commit", "-qm", "clean addition"]);

    let result = run(
        &fixture,
        "ci",
        &["--base", base.trim(), "--comparison", "introduced"],
        true,
    );
    assert_eq!(result["comparison"], "introduced");
    assert_eq!(result["verify"]["status"], "clean");
}

#[test]
fn introduced_ci_does_not_block_without_supported_source_changes() {
    let fixture = RepositoryFixture::new(&[("src/a.ts", "export const value = 1;\n")]);
    let base = String::from_utf8(
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(fixture.repo())
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();

    let identical = run(
        &fixture,
        "ci",
        &["--base", base.trim(), "--comparison", "introduced"],
        true,
    );
    assert_eq!(identical["verify"]["status"], "not_checked");

    fixture.write("README.md", "documentation only\n");
    git(fixture.repo(), &["add", "README.md"]);
    git(fixture.repo(), &["commit", "-qm", "documentation"]);
    let documentation_only = run(
        &fixture,
        "ci",
        &["--base", base.trim(), "--comparison", "introduced"],
        true,
    );
    assert_eq!(documentation_only["verify"]["status"], "not_checked");
}

#[test]
fn status_explains_staged_overrides_without_creating_analysis_cache() {
    let fixture = RepositoryFixture::new(&[("src/a.ts", "export const first = 1;\n")]);
    configure(
        &fixture,
        &json!({
            "schemaVersion":1,
            "verify":{"maxParameters":6},
            "workflows":{"pre-commit":{"verify":{"maxParameters":2}}}
        }),
    );
    git(fixture.repo(), &["add", ".opcore.json"]);
    fixture.write(".opcore.json", "invalid unstaged JSON");
    let output = opcore(
        fixture.repo(),
        fixture.cache(),
        "status",
        &["--workflow", "pre-commit", "--json"],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result = report(&output);
    assert_eq!(result["policy"]["effective"]["verify"]["maxParameters"], 2);
    assert!(
        result["policy"]["origins"]["/verify/maxParameters"]
            .as_str()
            .unwrap()
            .contains("pre-commit")
    );
    assert!(!fixture.cache().exists());
}

#[test]
fn native_selection_requires_explicit_host_execution_authorization() {
    let fixture = RepositoryFixture::new(&[("src/lib.rs", "pub fn ready() {}\n")]);
    configure(
        &fixture,
        &json!({"schemaVersion":1,"workflows":{"pre-commit":{"native":["rust-native"]}}}),
    );
    git(fixture.repo(), &["add", ".opcore.json"]);
    let output = run(&fixture, "pre-commit", &[], false);
    assert!(
        output["error"]
            .as_str()
            .unwrap()
            .contains("--allow-unsandboxed-native")
    );

    let introduced = run(
        &fixture,
        "pre-commit",
        &["--comparison", "introduced", "--allow-unsandboxed-native"],
        false,
    );
    assert_eq!(introduced["comparison"], "introduced");
    assert_eq!(introduced["native"]["comparison"], "introduced");
}

#[test]
fn explicit_coverage_settings_apply_to_hooks_and_only_acknowledge_known_builtins() {
    let fixture = RepositoryFixture::new(&[("src/read.ts", "export const ready = true;\n")]);
    fixture.write("src/read.ts", "export { readFile } from 'node:fs';\n");
    let default = run(&fixture, "post-edit", &[], true);
    assert_eq!(default["sense"]["status"], "partial");

    configure(
        &fixture,
        &json!({"schemaVersion":1,"coverage":{"allowPartial":false}}),
    );
    run(&fixture, "post-edit", &[], false);
    let blocked = hook(&fixture);
    assert_eq!(blocked.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("run post-edit --repo . --json"));
    assert!(
        String::from_utf8_lossy(&blocked.stderr)
            .contains("requires complete Project Sense coverage")
    );

    configure(
        &fixture,
        &json!({
            "schemaVersion":1,
            "coverage":{"allowPartial":false},
            "workflows":{"post-edit":{"coverage":{"allowNodeBuiltins":true}}}
        }),
    );
    run(&fixture, "post-edit", &[], true);
    assert!(hook(&fixture).status.success());

    fixture.write(
        "src/read.ts",
        "export { readFile } from 'node:unknown-builtin';\n",
    );
    run(&fixture, "post-edit", &[], false);
    assert_eq!(hook(&fixture).status.code(), Some(2));
}

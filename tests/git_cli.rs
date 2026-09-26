#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::symlink,
    path::Path,
    process::{Command, Output, Stdio},
};

#[cfg(target_os = "linux")]
use std::{ffi::OsString, os::unix::ffi::OsStringExt};

use serde_json::Value;

mod support;
use support::{RepositoryFixture, git};

fn git_text(repo: &Path, args: &[&str]) -> String {
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
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn initialize(repo: &Path) {
    fs::create_dir_all(repo.join("src")).unwrap();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.name", "Test"]);
    git(repo, &["config", "user.email", "test@example.com"]);
    fs::write(
        repo.join("src/a.ts"),
        "export function ok(a) { return a; }\n",
    )
    .unwrap();
    git(repo, &["add", "src/a.ts"]);
    git(repo, &["commit", "-qm", "initial"]);
}

fn check(repo: &Path, cache: &Path, args: &[&str]) -> Output {
    Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .arg("check")
        .arg("--repo")
        .arg(repo)
        .args(args)
        .arg("--json")
        .env("XDG_CACHE_HOME", cache)
        .output()
        .unwrap()
}

fn json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn disk_backed_gate_observes_an_edit_only_after_the_write() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);

    let before_write = check(&repo, &cache, &["--changed"]);
    assert!(before_write.status.success());
    let before_write = json(&before_write);
    assert_eq!(before_write["status"], "not_checked");
    assert_eq!(before_write["coverage"]["filesConsidered"], 0);
    assert_eq!(before_write["coverage"]["gaps"][0]["status"], "not_checked");

    fs::write(
        repo.join("src/a.ts"),
        "export function overloaded(a,b,c,d,e,f) { return a; }\n",
    )
    .unwrap();
    let after_write = check(&repo, &cache, &["--changed"]);
    assert!(!after_write.status.success());
    assert_eq!(json(&after_write)["status"], "findings");
}

#[test]
fn nested_clone_directories_share_repository_and_staged_capture() {
    let fixture = RepositoryFixture::new(&[("src/a.ts", "export const initial = true;\n")]);
    let repo = fixture.repo();
    let cache = fixture.cache();
    fs::write(
        repo.join("src/a.ts"),
        "export function overloaded(a,b,c,d,e,f) { return a; }\n",
    )
    .unwrap();
    git(repo, &["add", "src/a.ts"]);

    for scope in ["--changed", "--staged"] {
        let root = json(&check(repo, cache, &[scope]));
        let nested = json(&check(&repo.join("src"), cache, &[scope]));
        assert_eq!(root["status"], "findings");
        assert_eq!(nested["diagnostics"], root["diagnostics"]);
        assert_eq!(nested["validAsOf"], root["validAsOf"]);
    }
    fs::write(repo.join("src/a.ts"), "export const repaired = true;\n").unwrap();
    let staged = check(&repo.join("src"), cache, &["--staged"]);
    assert_eq!(json(&staged)["status"], "findings");
    let worktree = check(&repo.join("src"), cache, &["--changed"]);
    assert_eq!(json(&worktree)["status"], "clean");
}

#[test]
fn iac_shell_and_protobuf_are_checked_through_git_capture() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);
    fs::create_dir_all(repo.join("infra")).unwrap();
    fs::create_dir_all(repo.join("scripts")).unwrap();

    fs::write(
        repo.join("infra/main.tf"),
        "resource \"example_service\" \"main\" {\n  name = \"test\"\n}\n",
    )
    .unwrap();
    fs::write(
        repo.join("scripts/build.sh"),
        "#!/usr/bin/env bash\n[[ -n ${HOME} ]]\n",
    )
    .unwrap();
    fs::write(
        repo.join("schema.proto"),
        "syntax = \"proto3\"; message Example { string value = 1; }\n",
    )
    .unwrap();
    let clean = json(&check(&repo, &cache, &["--changed"]));
    assert_eq!(clean["status"], "clean");
    assert_eq!(clean["coverage"]["filesConsidered"], 3);
    assert_eq!(clean["coverage"]["filesCovered"], 3);

    fs::write(
        repo.join("infra/main.tf"),
        "resource \"example_service\" \"main\" {\n  name = [\n}\n",
    )
    .unwrap();
    fs::write(
        repo.join("scripts/build.sh"),
        "#!/bin/sh\n[[ -n ${HOME} ]]\n",
    )
    .unwrap();
    fs::write(
        repo.join("schema.proto"),
        "syntax = \"proto3\"; message Example { string value = ; }\n",
    )
    .unwrap();
    let findings = json(&check(&repo, &cache, &["--changed"]));
    assert_eq!(findings["status"], "findings");
    let diagnostics = findings["diagnostics"].as_array().unwrap();
    assert!(
        diagnostics
            .iter()
            .any(|item| { item["path"] == "infra/main.tf" && item["ruleId"] == "hcl.syntax" })
    );
    assert!(diagnostics.iter().any(|item| {
        item["path"] == "scripts/build.sh"
            && item["ruleId"] == "shell.syntax"
            && item["evidence"]["hostOs"] == std::env::consts::OS
    }));
    assert!(
        diagnostics
            .iter()
            .any(|item| { item["path"] == "schema.proto" && item["ruleId"] == "protobuf.syntax" })
    );
}

#[test]
fn tfvars_json_examples_use_json_syntax() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);

    let path = repo.join("dev.auto.tfvars.json.example");
    fs::write(&path, r#"{"region":"us-east-1"}"#).unwrap();
    fs::write(
        repo.join("dev.auto.tfvars.example.json"),
        r#"{"region":"us-west-2"}"#,
    )
    .unwrap();
    let clean = check(&repo, &cache, &["--changed"]);
    assert!(
        clean.status.success(),
        "{}",
        String::from_utf8_lossy(&clean.stderr)
    );
    assert_eq!(json(&clean)["status"], "clean");

    fs::write(&path, r#"{"region":}"#).unwrap();
    let findings = json(&check(&repo, &cache, &["--changed"]));
    assert_eq!(findings["status"], "findings");
    let diagnostic = findings["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["path"] == "dev.auto.tfvars.json.example")
        .expect("tfvars JSON syntax finding");
    assert_eq!(diagnostic["ruleId"], "hcl.syntax");
    assert_eq!(diagnostic["evidence"]["parser"], "serde_json");
}

#[test]
fn repository_paths_may_contain_newlines() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo\nline");
    let cache = temp.path().join("cache");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);

    let output = check(&repo, &cache, &["--all"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(json(&output)["status"], "clean");
}

#[test]
fn changed_staged_untracked_and_worktree_views_are_exact() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);

    fs::write(
        repo.join("src/a.ts"),
        "export function overloaded(a,b,c,d,e,f) { return a; }\n",
    )
    .unwrap();
    let first_output = check(&repo, &cache, &["--changed"]);
    assert!(!first_output.status.success());
    let first = json(&first_output);
    assert_eq!(first["status"], "findings");
    assert_eq!(first["cache"]["misses"], 2);
    assert!(
        check(&repo, &cache, &["--changed", "--advisory"])
            .status
            .success()
    );
    fs::write(
        repo.join("src/unsupported.py"),
        b"# coding: latin-1\nname = 'caf\xe9'\n",
    )
    .unwrap();
    let mixed = check(&repo, &cache, &["--changed", "--advisory"]);
    assert!(mixed.status.success());
    let mixed = json(&mixed);
    assert_eq!(mixed["status"], "findings");
    assert!(!mixed["diagnostics"].as_array().unwrap().is_empty());
    assert_eq!(mixed["coverage"]["gaps"][0]["status"], "unsupported");
    fs::remove_file(repo.join("src/unsupported.py")).unwrap();
    let warm = json(&check(&repo, &cache, &["--changed"]));
    assert_eq!(warm["cache"]["hits"], 2);
    assert_eq!(warm["cache"]["misses"], 0);

    git(&repo, &["add", "src/a.ts"]);
    let staged = json(&check(&repo, &cache, &["--staged"]));
    assert_eq!(staged["status"], "findings");
    fs::write(
        repo.join("src/new.py"),
        "def too_many(a,b,c,d,e,f):\n    return a\n",
    )
    .unwrap();
    let untracked = json(&check(&repo, &cache, &["--changed"]));
    assert!(
        untracked["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["path"] == "src/new.py")
    );

    fs::remove_file(repo.join("src/a.ts")).unwrap();
    let deleted = json(&check(&repo, &cache, &["--changed"]));
    assert!(
        !deleted["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["path"] == "src/a.ts")
    );
}

#[test]
fn linked_worktrees_share_only_content_facts_under_concurrency() {
    let temp = tempfile::tempdir().unwrap();
    let main = temp.path().join("main");
    let linked = temp.path().join("linked");
    let cache = temp.path().join("cache");
    fs::create_dir(&main).unwrap();
    initialize(&main);
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "linked",
            linked.to_str().unwrap(),
        ],
    );
    let finding = "export function overloaded(a,b,c,d,e,f) { return a; }\n";
    fs::write(main.join("src/a.ts"), finding).unwrap();
    fs::write(linked.join("src/a.ts"), finding).unwrap();

    let mut first = Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .args(["check", "--repo"])
        .arg(&main)
        .args(["--changed", "--json"])
        .env("XDG_CACHE_HOME", &cache)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut second = Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .args(["check", "--repo"])
        .arg(&linked)
        .args(["--changed", "--json"])
        .env("XDG_CACHE_HOME", &cache)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    assert!(!first.wait().unwrap().success());
    assert!(!second.wait().unwrap().success());

    let main_warm = json(&check(&main, &cache, &["--changed"]));
    let linked_warm = json(&check(&linked, &cache, &["--changed"]));
    assert_eq!(main_warm["cache"]["misses"], 0);
    assert_eq!(linked_warm["cache"]["misses"], 0);
    fs::write(
        linked.join("src/a.ts"),
        "export function clean(a) { return a; }\n",
    )
    .unwrap();
    let divergent = json(&check(&linked, &cache, &["--changed"]));
    assert_eq!(divergent["status"], "clean");
    assert_eq!(
        json(&check(&main, &cache, &["--changed"]))["status"],
        "findings"
    );
}

#[test]
fn committed_scope_is_exact_and_ignores_index_and_worktree_overlays() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);

    fs::write(
        repo.join("src/a.ts"),
        "export function dirty(a,b,c,d,e,f) { return a; }\n",
    )
    .unwrap();
    git(&repo, &["add", "src/a.ts"]);
    assert_eq!(
        json(&check(&repo, &cache, &["--committed"]))["status"],
        "clean"
    );
    assert_eq!(
        json(&check(&repo, &cache, &["--staged"]))["status"],
        "findings"
    );

    git(&repo, &["commit", "-qm", "add finding"]);
    fs::write(
        repo.join("src/a.ts"),
        "export function clean(a) { return a; }\n",
    )
    .unwrap();
    assert_eq!(
        json(&check(&repo, &cache, &["--committed"]))["status"],
        "findings"
    );
    assert_eq!(
        json(&check(&repo, &cache, &["--changed"]))["status"],
        "clean"
    );
}

#[test]
fn arbitrary_bases_and_trees_are_exact_and_ref_bound() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);
    let clean_commit = git_text(&repo, &["rev-parse", "HEAD"]);
    let clean_tree = git_text(&repo, &["rev-parse", "HEAD^{tree}"]);

    fs::write(
        repo.join("src/a.ts"),
        "export function introduced(a,b,c,d,e,f) { return a; }\n",
    )
    .unwrap();
    git(&repo, &["add", "src/a.ts"]);
    git(&repo, &["commit", "-qm", "introduce finding"]);
    let finding_commit = git_text(&repo, &["rev-parse", "HEAD"]);
    let finding_tree = git_text(&repo, &["rev-parse", "HEAD^{tree}"]);

    assert_eq!(
        json(&check(&repo, &cache, &["--changed"]))["status"],
        "not_checked"
    );
    let against_base = json(&check(
        &repo,
        &cache,
        &["--changed", "--base", &clean_commit],
    ));
    assert_eq!(against_base["status"], "findings");
    let valid_as_of: Value =
        serde_json::from_str(against_base["validAsOf"].as_str().unwrap()).unwrap();
    assert_eq!(valid_as_of["source"]["baseTree"], clean_tree);
    assert_eq!(valid_as_of["source"]["targetTree"], Value::Null);

    let staged_against_base = json(&check(
        &repo,
        &cache,
        &["--staged", "--base", &clean_commit],
    ));
    assert_eq!(staged_against_base["status"], "findings");

    fs::write(
        repo.join("src/a.ts"),
        "export function repaired(a) { return a; }\n",
    )
    .unwrap();
    let committed_tree = json(&check(
        &repo,
        &cache,
        &["--tree", &finding_commit, "--base", &clean_commit],
    ));
    assert_eq!(committed_tree["status"], "findings");
    let valid_as_of: Value =
        serde_json::from_str(committed_tree["validAsOf"].as_str().unwrap()).unwrap();
    assert_eq!(valid_as_of["source"]["baseTree"], clean_tree);
    assert_eq!(valid_as_of["source"]["targetTree"], finding_tree);

    assert_eq!(
        json(&check(&repo, &cache, &["--tree", &clean_commit]))["status"],
        "clean"
    );
}

#[test]
fn invalid_tree_references_fail_closed_without_running_a_shell() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);

    let output = check(&repo, &cache, &["--tree", "missing;touch PWNED"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("does not resolve to a tree"));
    assert!(!repo.join("PWNED").exists());
}

#[test]
fn all_scope_reads_only_current_state_and_sparse_worktrees_use_the_index() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);

    fs::write(
        repo.join("src/a.ts"),
        "export function staged(a,b,c,d,e,f) { return a; }\n",
    )
    .unwrap();
    git(&repo, &["add", "src/a.ts"]);
    git(&repo, &["update-index", "--skip-worktree", "src/a.ts"]);
    fs::remove_file(repo.join("src/a.ts")).unwrap();

    let changed = json(&check(&repo, &cache, &["--changed"]));
    assert_eq!(changed["status"], "findings");
    assert_eq!(changed["diagnostics"][0]["path"], "src/a.ts");
    let all = json(&check(&repo, &cache, &["--all"]));
    assert_eq!(all["status"], "findings");
    assert_eq!(all["timing"]["filesRead"], 1);
}

#[test]
fn mixed_monorepo_discovers_sources_without_executing_repository_files() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);
    fs::create_dir_all(repo.join("packages/node")).unwrap();
    fs::create_dir_all(repo.join("crates/core/src")).unwrap();
    fs::create_dir_all(repo.join("python/pkg")).unwrap();
    fs::write(repo.join("README.md"), "not source\n").unwrap();
    fs::write(
        repo.join("package.json"),
        r#"{"scripts":{"prepare":"touch SENTINEL"}}"#,
    )
    .unwrap();
    fs::write(repo.join("Cargo.toml"), "[workspace]\nmembers=[]\n").unwrap();
    fs::write(repo.join("pyproject.toml"), "[build-system]\nrequires=[]\n").unwrap();
    fs::write(
        repo.join("packages/node/eslint.config.js"),
        "require('node:fs').writeFileSync('SENTINEL', 'node'); export default [];\n",
    )
    .unwrap();
    fs::write(
        repo.join("crates/core/build.rs"),
        "fn main() { std::fs::write(\"SENTINEL\", \"rust\").unwrap(); }\n",
    )
    .unwrap();
    fs::write(repo.join("crates/core/src/lib.rs"), "pub fn ok() {}\n").unwrap();
    fs::write(
        repo.join("python/setup.py"),
        "from pathlib import Path\nPath('SENTINEL').write_text('python')\n",
    )
    .unwrap();
    fs::write(repo.join("python/pkg/__init__.py"), "def ok():\n    pass\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "mixed"]);

    let assessment = json(&check(&repo, &cache, &["--all"]));
    assert_eq!(assessment["status"], "clean");
    assert_eq!(assessment["coverage"]["filesConsidered"], 6);
    assert_eq!(assessment["coverage"]["filesCovered"], 6);
    assert_eq!(assessment["coverage"]["gaps"], serde_json::json!([]));
    assert!(!repo.join("SENTINEL").exists());

    fs::write(repo.join("python/pkg/foreign.go"), "package pkg\n").unwrap();
    let go = json(&check(&repo, &cache, &["--changed"]));
    assert_eq!(go["status"], "clean");
    assert_eq!(go["coverage"]["filesConsidered"], 1);
    assert_eq!(go["coverage"]["filesCovered"], 1);
    assert_eq!(go["coverage"]["gaps"], serde_json::json!([]));
}

#[test]
fn rename_and_hard_source_bounds_are_explicit() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);

    fs::write(
        repo.join("src/a.ts"),
        "export function existing(a,b,c,d,e,f) { return a; }\n",
    )
    .unwrap();
    git(&repo, &["add", "src/a.ts"]);
    git(&repo, &["commit", "-qm", "baseline finding"]);
    git(&repo, &["mv", "src/a.ts", "src/renamed.ts"]);
    let renamed = json(&check(&repo, &cache, &["--changed"]));
    assert_eq!(renamed["status"], "clean");
    assert_eq!(renamed["coverage"]["filesConsidered"], 2);
    assert_eq!(renamed["coverage"]["filesCovered"], 2);
    assert_eq!(renamed["coverage"]["gaps"], serde_json::json!([]));

    git(&repo, &["reset", "--hard", "-q", "HEAD"]);
    fs::copy(repo.join("src/a.ts"), repo.join("src/b.ts")).unwrap();
    git(&repo, &["add", "src/b.ts"]);
    git(&repo, &["commit", "-qm", "duplicate baseline finding"]);
    git(&repo, &["mv", "src/a.ts", "src/moved-a.ts"]);
    git(&repo, &["mv", "src/b.ts", "src/moved-b.ts"]);
    let duplicate_renames = json(&check(&repo, &cache, &["--changed"]));
    assert_eq!(duplicate_renames["status"], "clean");

    git(&repo, &["reset", "--hard", "-q", "HEAD"]);
    fs::write(
        repo.join("src/a.ts"),
        vec![b'x'; opcore::api::test_support::MAX_LINE_BYTES + 1],
    )
    .unwrap();
    let long_line = check(&repo, &cache, &["--changed"]);
    assert!(long_line.status.success());
    let long_line = json(&long_line);
    assert_eq!(long_line["status"], "clean");
    assert!(
        long_line["coverage"]["gaps"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("hard limit")
    );

    fs::write(
        repo.join("src/a.ts"),
        vec![b'x'; opcore::api::test_support::MAX_SOURCE_BYTES + 1],
    )
    .unwrap();
    let too_large = check(&repo, &cache, &["--changed"]);
    assert!(!too_large.status.success());
    assert!(String::from_utf8_lossy(&too_large.stderr).contains("exceeds"));
}

#[test]
fn symlinks_refuse() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);
    symlink("a.ts", repo.join("src/link.py")).unwrap();
    let symlinked = check(&repo, &cache, &["--changed"]);
    assert!(!symlinked.status.success());
    assert!(String::from_utf8_lossy(&symlinked.stderr).contains("not a regular file"));
    fs::remove_file(repo.join("src/link.py")).unwrap();
    symlink("missing-target.py", repo.join("src/broken.py")).unwrap();
    let broken = check(&repo, &cache, &["--changed"]);
    assert!(!broken.status.success());
    assert!(String::from_utf8_lossy(&broken.stderr).contains("not a regular file"));
    fs::remove_file(repo.join("src/broken.py")).unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn non_utf8_paths_degrade_without_leaking_absolute_paths() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);
    let name = OsString::from_vec(b"bad-\xff.py".to_vec());
    fs::write(repo.join("src").join(name), b"def ok():\n    pass\n").unwrap();
    let output = check(&repo, &cache, &["--changed"]);
    assert!(output.status.success());
    let assessment = json(&output);
    assert_eq!(assessment["status"], "clean");
    let rendered = String::from_utf8(output.stdout).unwrap();
    assert!(rendered.contains("bad-\\\\xff.py"));
    assert!(!rendered.contains(repo.to_str().unwrap()));
}

#[test]
fn explicit_unknown_supported_path_is_an_input_error() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);
    let missing = check(&repo, &cache, &["--files", "src/missing.ts"]);
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("path not found"));
}

#[test]
fn staged_scope_checks_an_unborn_repository_against_the_empty_tree() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q"]);
    fs::write(
        repo.join("src/a.ts"),
        "export function first_commit(a,b,c,d,e,f) { return a; }\n",
    )
    .unwrap();
    git(&repo, &["add", "src/a.ts"]);

    let staged = json(&check(&repo, &cache, &["--staged"]));
    assert_eq!(staged["status"], "findings");
    assert_eq!(staged["diagnostics"][0]["path"], "src/a.ts");
}

#![cfg(unix)]

use std::{
    fs,
    path::Path,
    process::{Command, Output, Stdio},
};

use serde_json::{Value, json};

fn git(repo: &Path, args: &[&str]) {
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .status()
            .unwrap()
            .success()
    );
}

fn initialize(repo: &Path, files: &[(&str, &str)]) {
    assert!(
        !files.is_empty(),
        "fixture requires at least one source file"
    );
    fs::create_dir_all(repo).unwrap();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.name", "Test"]);
    git(repo, &["config", "user.email", "test@example.com"]);
    for (path, source) in files {
        let absolute = repo.join(path);
        fs::create_dir_all(absolute.parent().unwrap()).unwrap();
        fs::write(absolute, source).unwrap();
    }
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "initial"]);
}

fn sense(repo: &Path, cache: &Path, request: &Value) -> Output {
    let mut child = Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .args(["sense", "--repo"])
        .arg(repo)
        .args(["--hypothetical", "-", "--json"])
        .env("XDG_CACHE_HOME", cache)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    serde_json::to_writer(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    child.wait_with_output().unwrap()
}

fn output_json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn source_overlay_is_in_memory_and_introduced_only() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(
        &repo,
        &[
            ("src/a.ts", "import './b';\nexport const a = 1;\n"),
            ("src/b.ts", "export const b = 1;\n"),
        ],
    );
    let cycle = sense(
        &repo,
        &cache,
        &json!({"schemaVersion":1,"changes":[{
            "action":"write","path":"src/b.ts",
            "content":"import './a';\nexport const b = 1;\n"
        }]}),
    );
    assert!(!cycle.status.success());
    let report = output_json(&cycle);
    assert_eq!(report["introducedCycles"][0]["memberCount"], 2);
    assert!(
        report["validAsOf"]
            .as_str()
            .unwrap()
            .contains("git-hypothetical")
    );
    assert_eq!(
        fs::read_to_string(repo.join("src/b.ts")).unwrap(),
        "export const b = 1;\n"
    );

    fs::write(
        repo.join("src/b.ts"),
        "import './a';\nexport const b = 1;\n",
    )
    .unwrap();
    let existing = sense(
        &repo,
        &cache,
        &json!({"schemaVersion":1,"changes":[{
            "action":"write","path":"src/b.ts",
            "content":"// edit\nimport './a';\nexport const b = 1;\n"
        }]}),
    );
    assert!(existing.status.success());
    assert!(
        output_json(&existing)["introducedCycles"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn go_module_overlay_rebuilds_dependencies_without_writing_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(
        &repo,
        &[
            ("go.mod", "module example.com/old\n"),
            (
                "a/a.go",
                "package a\nimport \"example.com/new/b\"\nfunc A() { b.B() }\n",
            ),
            (
                "b/b.go",
                "package b\nimport \"example.com/new/a\"\nfunc B() { a.A() }\n",
            ),
        ],
    );
    let report = sense(
        &repo,
        &cache,
        &json!({"schemaVersion":1,"changes":[{
            "action":"write","path":"go.mod","content":"module example.com/new\n"
        }]}),
    );
    assert!(!report.status.success());
    let report = output_json(&report);
    assert_eq!(report["status"], "partial", "{report:#}");
    assert_eq!(report["changedFiles"], 1);
    assert_eq!(report["after"]["runtimeEdges"], 2);
    assert_eq!(
        fs::read_to_string(repo.join("go.mod")).unwrap(),
        "module example.com/old\n"
    );
}

#[test]
fn documentation_overlay_is_exact_and_never_written() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(&repo, &[("src/core.ts", "export const core = 1;\n")]);
    for index in 0..9 {
        fs::write(
            repo.join(format!("src/importer-{index}.ts")),
            "import './core';\nexport const importer = true;\n",
        )
        .unwrap();
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "nine importers"]);
    let registry = concat!(
        r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/core.ts","#,
        r#""document":"docs/core.md"}]}}"#,
    );
    let documented = sense(
        &repo,
        &cache,
        &json!({"schemaVersion":1,"changes":[
            {"action":"write","path":"src/importer-9.ts","content":"import './core';\n"},
            {"action":"write","path":"src/core.ts","content":"export const renamed = 1;\n"},
            {"action":"write","path":".opcore.json","content":registry},
            {"action":"write","path":"docs/core.md","content":"Core ownership.\n"}
        ]}),
    );
    assert!(documented.status.success());
    let report = output_json(&documented);
    assert_eq!(report["documentationCoverage"]["afterRegistry"], "valid");
    assert_eq!(report["documentationCoverage"]["changedDocuments"], 1);
    assert!(!repo.join("src/importer-9.ts").exists());
    assert!(!repo.join(".opcore.json").exists());
    assert!(!repo.join("docs/core.md").exists());
}

#[test]
fn invalid_request_returns_structured_incomplete_output() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    initialize(&repo, &[("src/a.ts", "export const a = 1;\n")]);
    let invalid = sense(
        &repo,
        &temp.path().join("cache"),
        &json!({"schemaVersion":1,"changes":[],"unknown":true}),
    );
    assert!(!invalid.status.success());
    let report = output_json(&invalid);
    assert_eq!(report["status"], "incomplete");
    assert_eq!(report["issues"][0]["code"], "hypothesis_invalid");
}

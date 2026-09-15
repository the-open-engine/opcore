#![cfg(unix)]

use std::{fs, path::Path};

mod support;
use support::{RepositoryFixture, git, json, opcore_json, sense};

#[test]
fn exclusions_are_visible_and_cross_boundary_imports_remain_partial() {
    let fixture = RepositoryFixture::new(&[
        ("app.ts", "export const app = 1;\n"),
        ("excluded/dependency.ts", "malformed excluded source"),
        (
            ".opcore.json",
            r#"{"schemaVersion":1,"targets":{"exclude":["excluded"]}}"#,
        ),
    ]);
    fixture.write(
        "app.ts",
        "import './excluded/dependency';\nexport const app = 1;\n",
    );
    let output = opcore_json(&fixture, "sense", &[]);
    assert!(!output.status.success());
    let report = json(&output);
    assert_eq!(report["status"], "partial");
    assert_eq!(report["after"]["files"], 1);
    assert_eq!(report["effectivePolicy"]["excludedPaths"][0], "excluded");
}

#[test]
fn repaired_configuration_uses_baseline_documentation_without_baseline_thresholds() {
    let fixture = RepositoryFixture::new(&[
        ("src/core.ts", "export const core = 1;\n"),
        (
            ".opcore.json",
            r#"{"schemaVersion":1,"verify":{"maxParameters":"broken"},"documentation":{"bindings":[{"source":"src/core.ts","document":"guide.md"}]}}"#,
        ),
        ("guide.md", "Old public API.\n"),
    ]);
    let repo = fixture.repo();
    let cache = fixture.cache();
    for index in 0..10 {
        fs::write(
            repo.join(format!("src/user-{index}.ts")),
            "import './core';\n",
        )
        .unwrap();
    }
    git(repo, &["add", "."]);
    git(
        repo,
        &["commit", "-qm", "important baseline with invalid threshold"],
    );
    write_documented_rename(repo);
    let output = sense(repo, cache, false);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report = json(&output);
    assert_eq!(report["documentationCoverage"]["beforeRegistry"], "valid");
    assert!(
        report["documentationRequirements"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    git(repo, &["reset", "--hard", "HEAD"]);
    fs::write(
        repo.join(".opcore.json"),
        r#"{"schemaVersion":1,"documentation":{"bindings":"broken"}}"#,
    )
    .unwrap();
    git(repo, &["add", ".opcore.json"]);
    git(repo, &["commit", "-qm", "malformed documentation baseline"]);
    write_documented_rename(repo);
    let malformed = sense(repo, cache, false);
    assert!(!malformed.status.success());
    let report = json(&malformed);
    assert_eq!(report["status"], "incomplete");
    assert_eq!(report["documentationCoverage"]["beforeRegistry"], "invalid");
    assert_eq!(report["documentationCoverage"]["afterRegistry"], "valid");
}

fn write_documented_rename(repo: &Path) {
    fs::write(repo.join(".opcore.json"), r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/core.ts","document":"guide.md"}]}}"#).unwrap();
    fs::write(repo.join("src/core.ts"), "export const renamed = 1;\n").unwrap();
    fs::write(repo.join("guide.md"), "Renamed public API.\n").unwrap();
}

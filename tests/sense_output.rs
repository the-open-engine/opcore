#![cfg(unix)]

use std::fs;

use serde_json::Value;

mod support;
use support::{git, json, sense};

fn sense_value(repo: &std::path::Path, cache: &std::path::Path) -> Value {
    let output = sense(repo, cache, true);
    assert!(
        output.status.success(),
        "sense: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    json(&output)
}

fn normalized(mut report: Value) -> Value {
    let object = report.as_object_mut().unwrap();
    for process_fact in ["timing", "cache", "validAsOf"] {
        object.remove(process_fact);
    }
    report
}

#[test]
fn repeated_sense_has_identical_full_semantic_output() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["config", "user.name", "Test"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    fs::write(
        repo.join("src/a.ts"),
        "import './b';\nexport interface PublicShape { value: string }\n",
    )
    .unwrap();
    fs::write(repo.join("src/b.ts"), "export const b = 1;\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "initial"]);
    fs::write(
        repo.join("src/b.ts"),
        "import './a';\nexport const b = 1;\n",
    )
    .unwrap();

    let cold = sense_value(&repo, &cache);
    let warm = sense_value(&repo, &cache);

    assert_eq!(cold["status"], "findings");
    assert_eq!(normalized(cold), normalized(warm));
}

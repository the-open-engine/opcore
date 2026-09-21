#![cfg(unix)]

use std::{fmt::Write as _, fs, path::Path};

mod support;
use support::{RepositoryFixture, assert_region_duplicate, blocking_sense, git, json, sense};

fn initialize(repo: &Path, files: &[(&str, &str)]) {
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

fn callable_body() -> String {
    let mut body = String::from("    accumulator = seed + 1\n");
    for index in 0..20 {
        writeln!(body, "    value_{index:02} = accumulator + {index}").unwrap();
    }
    body.push_str("    return value_19\n");
    body
}

fn python_callable(module: &str, name: &str, extra_decorator: bool) -> String {
    let mut source = format!(
        "__all__ = [\"{name}\"]\n\ndef {module}_wrapper(function):\n    return function\n\n@{module}_wrapper\n"
    );
    if extra_decorator {
        source.push_str("@staticmethod\n");
    }
    writeln!(
        source,
        "def {name}(seed: int = 0, *, enabled: bool = True) -> int:"
    )
    .unwrap();
    source.push_str(&callable_body());
    source
}

fn python_partial_region(name: &str, prefix: &str, suffix: &str) -> String {
    let mut source =
        format!("def {name}(values: list[int]) -> int:\n    total = len(values)\n    {prefix}\n");
    for index in 0..16 {
        writeln!(source, "    total = total + values[{index}]").unwrap();
    }
    writeln!(source, "    {suffix}\n    return total").unwrap();
    source
}

#[test]
fn python_partial_region_is_detected_without_a_callable_cascade() {
    let fixture = RepositoryFixture::new(&[(
        "src/alpha.py",
        &python_partial_region("alpha", "alpha_only = 1", "del alpha_only"),
    )]);
    fixture.write(
        "src/beta.py",
        &python_partial_region("beta", "beta_only = values[0] * 2", "print(beta_only)"),
    );
    let report = blocking_sense(fixture.repo(), fixture.cache());
    let finding = assert_region_duplicate(&report, "python", 1, 2);
    assert!(finding["occurrences"][0].get("callableKind").is_none());
}

#[test]
fn python_callable_copy_is_exact_introduced_only_and_advisory() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(
        &repo,
        &[(
            "src/ledger/alpha.py",
            &python_callable("alpha", "calculate_alpha", false),
        )],
    );

    fs::write(
        repo.join("src/ledger/beta.py"),
        python_callable("beta", "calculate_beta", true),
    )
    .unwrap();
    let blocking = sense(&repo, &cache, false);
    assert!(!blocking.status.success());
    let report = json(&blocking);
    assert_eq!(report["status"], "findings");
    let findings = report["introducedDuplicates"].as_array().unwrap();
    assert_eq!(findings.len(), 1, "whole-file duplication must not cascade");
    let finding = &findings[0];
    assert_eq!(finding["kind"], "callable_body");
    assert_eq!(finding["languageFamily"], "python");
    assert_eq!(finding["beforeCount"], 1);
    assert_eq!(finding["afterCount"], 2);
    assert_eq!(finding["introducedCount"], 1);
    assert!(finding["tokenCount"].as_u64().unwrap() >= 48);
    let occurrences = finding["occurrences"].as_array().unwrap();
    assert_eq!(occurrences.len(), 2);
    assert_eq!(occurrences[0]["path"], "src/ledger/beta.py");
    assert_eq!(occurrences[0]["changed"], true);
    assert_eq!(occurrences[0]["callableKind"], "function");
    assert!(occurrences[0]["range"]["start"]["line"].as_u64().unwrap() > 1);
    assert!(
        occurrences[0]["range"]["end"]["byte"].as_u64().unwrap()
            > occurrences[0]["range"]["start"]["byte"].as_u64().unwrap()
    );
    assert_eq!(occurrences[1]["path"], "src/ledger/alpha.py");
    assert_eq!(occurrences[1]["changed"], false);
    assert!(occurrences[1]["range"].is_object());

    let advisory = sense(&repo, &cache, true);
    assert!(advisory.status.success());
    assert_eq!(json(&advisory)["status"], "findings");

    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "accept duplicate debt"]);
    let debt = sense(&repo, &cache, false);
    assert!(debt.status.success());
    assert_eq!(json(&debt)["status"], "clean");

    fs::write(
        repo.join("src/ledger/gamma.py"),
        python_callable("gamma", "calculate_gamma", false),
    )
    .unwrap();
    let expanded = sense(&repo, &cache, false);
    assert!(!expanded.status.success());
    let expanded_report = json(&expanded);
    assert_eq!(
        expanded_report["introducedDuplicates"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(expanded_report["introducedDuplicates"][0]["beforeCount"], 2);
    assert_eq!(expanded_report["introducedDuplicates"][0]["afterCount"], 3);
}

fn python_exports(last: &str) -> String {
    let mut names = (0..20)
        .map(|index| format!("\"public_{index:02}\""))
        .collect::<Vec<_>>();
    names.push(format!("\"{last}\""));
    format!("__all__ = [{}]\n", names.join(", "))
}

#[test]
fn static_python_all_drives_exact_documentation_enforcement() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    let source_path = "src/acme/platform/public_api.py";
    initialize(
        &repo,
        &[
            (source_path, &python_exports("legacy_name")),
            (
                ".opcore.json",
                concat!(
                    r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/acme/platform/public_api.py","#,
                    r#""document":"docs/platform/public-api.md"}]}}"#,
                ),
            ),
            ("docs/platform/public-api.md", "Public API exports.\n"),
        ],
    );

    fs::write(repo.join(source_path), python_exports("replacement_name")).unwrap();
    let stale = sense(&repo, &cache, false);
    assert!(!stale.status.success());
    let report = json(&stale);
    assert_eq!(report["status"], "findings");
    assert!(
        report["introducedDuplicates"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(report["interfaceFindings"].as_array().unwrap().is_empty());
    let important = report["observations"]["importantNodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["path"] == source_path)
        .unwrap();
    assert_eq!(important["beforeExplicitExports"], 21);
    assert_eq!(important["afterExplicitExports"], 21);
    assert_eq!(important["beforePublicSurfaceAuthoritative"], true);
    assert_eq!(important["afterPublicSurfaceAuthoritative"], true);
    assert_eq!(important["publicSurfaceChanged"], true);
    assert_eq!(
        report["documentationRequirements"][0]["code"],
        "sense.documentation.document_not_updated"
    );
    assert_eq!(report["documentationRequirements"][0]["path"], source_path);
    assert_eq!(
        report["documentationRequirements"][0]["document"],
        "docs/platform/public-api.md"
    );
    assert_eq!(report["documentationCoverage"]["evaluated"], true);
    assert_eq!(report["documentationCoverage"]["documentsRequested"], 1);
    assert_eq!(report["documentationCoverage"]["changedDocuments"], 0);

    fs::write(
        repo.join("docs/platform/public-api.md"),
        "Public API exports, including replacement_name.\n",
    )
    .unwrap();
    let repaired = sense(&repo, &cache, false);
    assert!(repaired.status.success());
    let repaired_report = json(&repaired);
    assert_eq!(repaired_report["status"], "clean");
    assert!(
        repaired_report["documentationRequirements"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        repaired_report["documentationCoverage"]["changedDocuments"],
        1
    );
}

#[test]
fn bound_important_python_without_static_all_reports_documentation_surface_gap() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(
        &repo,
        &[
            ("pkg/__init__.py", ""),
            ("pkg/core.py", "def alpha(value):\n    return value + 1\n"),
            ("pkg/one.py", "from .core import alpha\n"),
            ("pkg/two.py", "from .core import alpha\n"),
            ("pkg/three.py", "from .core import alpha\n"),
            (
                ".opcore.json",
                r#"{"schemaVersion":1,"sense":{"importantFanIn":2},"documentation":{"bindings":[{"source":"pkg/core.py","document":"docs/core.md"}]}}"#,
            ),
            ("docs/core.md", "Core API.\n"),
        ],
    );

    fs::write(
        repo.join("pkg/core.py"),
        "def alpha(value):\n    return value + 1\n\ndef beta(value):\n    return value + 2\n",
    )
    .unwrap();

    let output = sense(&repo, &cache, false);
    assert!(!output.status.success());
    let report = json(&output);
    assert_eq!(report["status"], "partial");
    assert!(
        report["documentationRequirements"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        report["documentationCoverage"]["publicSurfaceCandidates"],
        1
    );
    assert_eq!(
        report["documentationCoverage"]["authoritativePublicSurfaces"],
        0
    );
    assert_eq!(
        report["documentationCoverage"]["unavailablePublicSurfaces"],
        1
    );
    let issue = report["issues"]
        .as_array()
        .unwrap()
        .iter()
        .find(|issue| issue["code"] == "sense.documentation.public_surface_unavailable")
        .unwrap();
    assert_eq!(issue["paths"][0], "pkg/core.py");
    assert!(issue["message"].as_str().unwrap().contains("docs/core.md"));

    let human = support::opcore(&repo, &cache, "sense", &["--allow-partial"]);
    assert!(human.status.success());
    assert!(
        String::from_utf8_lossy(&human.stdout).contains(
            "documentation public-surface coverage: 0/1 bound important changed Python sources authoritative; 1 unavailable"
        )
    );
}

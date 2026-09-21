#![cfg(unix)]

use std::{fmt::Write as _, fs, path::Path};

use serde_json::Value;

mod support;
use support::{git, json, sense};

fn initialize(repo: &Path, files: &[(String, String)]) {
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

fn assert_complete_node_coverage(report: &Value, files: usize, references: usize) {
    assert_eq!(report["after"]["coverage"]["files"], files);
    assert_eq!(report["after"]["coverage"]["completeFiles"], files);
    assert_eq!(
        report["after"]["coverage"]["resolvedReferences"],
        references
    );
    assert_eq!(report["after"]["coverage"]["ambiguousReferences"], 0);
    assert_eq!(report["after"]["coverage"]["unresolvedReferences"], 0);
    assert_eq!(report["after"]["coverage"]["parserFailedFiles"], 0);
    assert_eq!(report["after"]["interfaceCoverage"]["completeFiles"], 1);
    assert_eq!(
        report["after"]["interfaceCoverage"]["completePublicSurfaces"],
        1
    );
    assert!(report["issues"].as_array().unwrap().is_empty());
}

fn assert_finding(report: &Value, expected: (&str, &str, usize, usize, usize)) {
    let (code, metric, before, after, limit) = expected;
    let findings = report["interfaceFindings"].as_array().unwrap();
    assert_eq!(findings.len(), 1, "{report:#}");
    assert_eq!(findings[0]["code"], code);
    assert_eq!(findings[0]["metric"], metric);
    assert_eq!(findings[0]["before"], before);
    assert_eq!(findings[0]["after"], after);
    assert_eq!(findings[0]["limit"], limit);
    assert_eq!(findings[0]["basis"], "confirmed");
}

fn dependency_imports(count: usize) -> String {
    (0..count).fold(String::new(), |mut source, index| {
        writeln!(source, "import './target_{index:02}';").unwrap();
        source
    })
}

#[test]
fn confirmed_dependency_targets_enforce_boundary_and_introduced_only_debt() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    let mut files = (0..21)
        .map(|index| {
            (
                format!("src/target_{index:02}.ts"),
                format!("export const target_{index:02} = {index};\n"),
            )
        })
        .collect::<Vec<_>>();
    files.push(("src/hub.ts".into(), dependency_imports(20)));
    initialize(&repo, &files);

    let boundary = sense(&repo, &cache, false);
    assert!(boundary.status.success());
    assert_eq!(json(&boundary)["status"], "clean");

    fs::write(repo.join("src/hub.ts"), dependency_imports(21)).unwrap();
    let blocked = sense(&repo, &cache, false);
    assert!(!blocked.status.success());
    let report = json(&blocked);
    assert_eq!(report["status"], "findings");
    assert_eq!(report["effectivePolicy"]["maxDependencyTargets"], 20);
    assert_finding(
        &report,
        (
            "sense.interface.dependency_targets",
            "confirmed_dependency_targets",
            20,
            21,
            20,
        ),
    );
    assert_eq!(report["interfaceFindings"][0]["path"], "src/hub.ts");
    assert_complete_node_coverage(&report, 22, 21);

    let advisory = sense(&repo, &cache, true);
    assert!(advisory.status.success());
    assert_eq!(json(&advisory)["status"], "findings");

    git(&repo, &["add", "src/hub.ts"]);
    git(&repo, &["commit", "-qm", "accept dependency debt"]);
    fs::write(
        repo.join("src/hub.ts"),
        format!("{}// unrelated edit\n", dependency_imports(21)),
    )
    .unwrap();
    let retained_debt = sense(&repo, &cache, false);
    assert!(retained_debt.status.success());
    let report = json(&retained_debt);
    assert_eq!(report["status"], "clean");
    assert!(report["interfaceFindings"].as_array().unwrap().is_empty());
}

fn target_exports(namespace: &str, count: usize) -> String {
    (0..count).fold(String::new(), |mut source, index| {
        if namespace == "type" {
            writeln!(source, "export type Value_{index:02} = string;").unwrap();
        } else {
            writeln!(source, "export const value_{index:02} = {index};").unwrap();
        }
        source
    })
}

fn selector_import(namespace: &str, count: usize) -> String {
    let names = (0..count)
        .map(|index| {
            if namespace == "type" {
                format!("Value_{index:02}")
            } else {
                format!("value_{index:02}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let prefix = if namespace == "type" {
        "import type"
    } else {
        "import"
    };
    format!("{prefix} {{ {names} }} from './target';\n")
}

fn python_target_exports(count: usize) -> String {
    (0..count).fold(String::new(), |mut source, index| {
        writeln!(source, "def value_{index:02}():\n    return {index}\n").unwrap();
        source
    })
}

fn python_selector_import(relative: bool, count: usize) -> String {
    let names = (0..count)
        .map(|index| format!("value_{index:02}"))
        .collect::<Vec<_>>()
        .join(", ");
    let prefix = if relative { "." } else { "" };
    format!("from {prefix}target import {names}\n")
}

#[test]
fn runtime_and_type_edge_selectors_enforce_boundary_and_introduced_only_debt() {
    for (namespace, metric, reference_field) in [
        (
            "runtime",
            "confirmed_runtime_edge_selectors",
            "runtimeReferences",
        ),
        ("type", "confirmed_type_edge_selectors", "typeReferences"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let cache = temp.path().join("cache");
        initialize(
            &repo,
            &[
                ("src/target.ts".into(), target_exports(namespace, 9)),
                ("src/client.ts".into(), selector_import(namespace, 8)),
            ],
        );

        let boundary = sense(&repo, &cache, false);
        assert!(boundary.status.success());
        assert_eq!(json(&boundary)["status"], "clean");

        fs::write(repo.join("src/client.ts"), selector_import(namespace, 9)).unwrap();
        let blocked = sense(&repo, &cache, false);
        assert!(!blocked.status.success(), "namespace={namespace}");
        let report = json(&blocked);
        assert_eq!(report["status"], "findings");
        assert_eq!(report["effectivePolicy"]["maxEdgeSelectors"], 8);
        assert_finding(&report, ("sense.interface.edge_selectors", metric, 8, 9, 8));
        assert_eq!(report["interfaceFindings"][0]["path"], "src/client.ts");
        assert_eq!(report["interfaceFindings"][0]["target"], "src/target.ts");
        assert_eq!(report["after"]["coverage"][reference_field], 1);
        assert_eq!(report["after"]["interfaceCoverage"]["resolvedSelectors"], 9);
        assert_complete_node_coverage(&report, 2, 1);

        let advisory = sense(&repo, &cache, true);
        assert!(advisory.status.success());
        assert_eq!(json(&advisory)["status"], "findings");

        git(&repo, &["add", "src/client.ts"]);
        git(&repo, &["commit", "-qm", "accept selector debt"]);
        fs::write(
            repo.join("src/client.ts"),
            format!("{}// unrelated edit\n", selector_import(namespace, 9)),
        )
        .unwrap();
        let retained_debt = sense(&repo, &cache, false);
        assert!(retained_debt.status.success());
        let report = json(&retained_debt);
        assert_eq!(report["status"], "clean");
        assert!(report["interfaceFindings"].as_array().unwrap().is_empty());
    }
}

#[test]
fn python_absolute_and_relative_sibling_imports_enforce_selector_limits_equally() {
    for relative in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let cache = temp.path().join("cache");
        initialize(
            &repo,
            &[
                ("pkg/target.py".into(), python_target_exports(9)),
                ("pkg/client.py".into(), python_selector_import(relative, 8)),
            ],
        );

        let boundary = sense(&repo, &cache, false);
        assert!(boundary.status.success(), "relative={relative}");
        assert_eq!(json(&boundary)["status"], "clean");

        fs::write(
            repo.join("pkg/client.py"),
            python_selector_import(relative, 9),
        )
        .unwrap();
        let blocked = sense(&repo, &cache, false);
        assert!(!blocked.status.success(), "relative={relative}");
        let report = json(&blocked);
        assert_eq!(report["status"], "partial");
        assert_finding(
            &report,
            (
                "sense.interface.edge_selectors",
                "confirmed_runtime_edge_selectors",
                8,
                9,
                8,
            ),
        );
        assert_eq!(report["interfaceFindings"][0]["path"], "pkg/client.py");
        assert_eq!(report["interfaceFindings"][0]["target"], "pkg/target.py");
        assert_eq!(report["after"]["runtimeEdges"], 1);
        assert_eq!(report["after"]["coverage"]["resolvedReferences"], 1);
        assert_eq!(report["after"]["interfaceCoverage"]["resolvedSelectors"], 9);
    }
}

fn exported_shape(kind: &str, count: usize) -> String {
    let members = (0..count).fold(String::new(), |mut source, index| {
        writeln!(source, "  member_{index:02}: string;").unwrap();
        source
    });
    if kind == "interface" {
        format!("export interface Surface {{\n{members}}}\n")
    } else {
        format!("export type Surface = {{\n{members}}};\n")
    }
}

#[test]
fn exported_shapes_enforce_member_boundary_and_introduced_only_debt() {
    for (kind, metric) in [
        ("interface", "exported_interface_members"),
        ("type_literal", "exported_type_literal_members"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let cache = temp.path().join("cache");
        initialize(
            &repo,
            &[("src/contracts.ts".into(), exported_shape(kind, 20))],
        );

        let boundary = sense(&repo, &cache, false);
        assert!(boundary.status.success());
        assert_eq!(json(&boundary)["status"], "clean");

        fs::write(repo.join("src/contracts.ts"), exported_shape(kind, 21)).unwrap();
        let blocked = sense(&repo, &cache, false);
        assert!(!blocked.status.success(), "kind={kind}");
        let report = json(&blocked);
        assert_eq!(report["status"], "findings");
        assert_eq!(report["effectivePolicy"]["maxShapeMembers"], 20);
        assert_finding(
            &report,
            ("sense.interface.shape_members", metric, 20, 21, 20),
        );
        assert_eq!(report["interfaceFindings"][0]["path"], "src/contracts.ts");
        assert_eq!(report["interfaceFindings"][0]["entity"], "Surface");
        assert_eq!(report["after"]["interfaceCoverage"]["resolvedSelectors"], 0);
        assert_complete_node_coverage(&report, 1, 0);

        let advisory = sense(&repo, &cache, true);
        assert!(advisory.status.success());
        assert_eq!(json(&advisory)["status"], "findings");

        git(&repo, &["add", "src/contracts.ts"]);
        git(&repo, &["commit", "-qm", "accept shape debt"]);
        fs::write(
            repo.join("src/contracts.ts"),
            format!("{}// unrelated edit\n", exported_shape(kind, 21)),
        )
        .unwrap();
        let retained_debt = sense(&repo, &cache, false);
        assert!(retained_debt.status.success());
        let report = json(&retained_debt);
        assert_eq!(report["status"], "clean");
        assert!(report["interfaceFindings"].as_array().unwrap().is_empty());
    }
}

#[test]
fn unknown_baseline_edge_width_does_not_fabricate_an_introduced_violation() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(
        &repo,
        &[
            ("src/target.ts".into(), target_exports("runtime", 9)),
            (
                "src/client.ts".into(),
                "import * as target from './target';\nvoid target;\n".into(),
            ),
        ],
    );

    fs::write(repo.join("src/client.ts"), selector_import("runtime", 9)).unwrap();
    let output = sense(&repo, &cache, false);
    assert_eq!(output.status.code(), Some(1));
    let report = json(&output);
    assert_eq!(report["status"], "partial");
    assert!(report["interfaceFindings"].as_array().unwrap().is_empty());
    assert_eq!(report["before"]["interfaceCoverage"]["partialFiles"], 1);
    assert_eq!(
        report["before"]["interfaceCoverage"]["gaps"]["namespaceImports"],
        1
    );
    assert_eq!(report["after"]["interfaceCoverage"]["completeFiles"], 1);
    assert_eq!(report["after"]["interfaceCoverage"]["resolvedSelectors"], 9);
}

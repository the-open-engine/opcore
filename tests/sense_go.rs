#![cfg(unix)]

mod support;

use support::{RepositoryFixture, git, json as report, sense, sense_staged};

fn worktree_report(fixture: &RepositoryFixture) -> serde_json::Value {
    report(&sense(fixture.repo(), fixture.cache(), true))
}

#[test]
fn resolves_local_packages_and_reports_introduced_runtime_cycles() {
    let fixture = RepositoryFixture::new(&[
        ("go.mod", "module example.com/project\n\ngo 1.24\n"),
        (
            "a/a.go",
            "package a\nimport \"example.com/project/b\"\nfunc A() { b.B() }\n",
        ),
        ("b/b.go", "package b\nfunc B() {}\n"),
    ]);
    fixture.write(
        "b/b.go",
        "package b\nimport \"example.com/project/a\"\nfunc B() { a.A() }\n",
    );

    let report = worktree_report(&fixture);
    assert_eq!(report["status"], "findings", "{report:#}");
    assert_eq!(report["changedFiles"], 1);
    assert_eq!(report["after"]["runtimeEdges"], 2);
    assert_eq!(report["after"]["coverage"]["resolvedReferences"], 2);
    assert_eq!(report["after"]["coverage"]["externalReferences"], 0);
    assert_eq!(report["introducedCycles"][0]["memberCount"], 2);
}

#[test]
fn nested_modules_are_exact_and_invalid_metadata_fails_closed() {
    let fixture = RepositoryFixture::new(&[
        ("go.mod", "module example.com/root\n"),
        ("nested/go.mod", "module example.com/nested\n"),
        (
            "rootpkg/root.go",
            "package rootpkg\nimport \"example.com/nested/q\"\nfunc Root() { q.Q() }\n",
        ),
        ("nested/q/q.go", "package q\nfunc Q() {}\n"),
    ]);
    fixture.write(
        "nested/q/q.go",
        "package q\nimport \"example.com/root/rootpkg\"\nfunc Q() { rootpkg.Root() }\n",
    );
    let cycle = worktree_report(&fixture);
    assert_eq!(cycle["status"], "findings", "{cycle:#}");
    assert_eq!(cycle["after"]["coverage"]["resolvedReferences"], 2);
    assert_eq!(cycle["introducedCycles"][0]["memberCount"], 2);

    fixture.write("go.mod", "module ../invalid\n");
    let invalid = worktree_report(&fixture);
    assert_eq!(invalid["status"], "incomplete");
    assert_eq!(invalid["after"]["coverage"]["configurationErrors"], 1);
    assert_eq!(invalid["changedFiles"], 2);
}

#[test]
fn module_only_changes_rebuild_the_exact_graph_view() {
    let fixture = cycle_module_fixture();
    fixture.write("go.mod", "module example.com/new\n");

    let report = worktree_report(&fixture);
    assert_eq!(report["status"], "partial", "{report:#}");
    assert_eq!(report["changedFiles"], 1);
    assert_ne!(report["before"]["viewId"], report["after"]["viewId"]);
    assert_eq!(report["before"]["runtimeEdges"], 0);
    assert_eq!(report["after"]["runtimeEdges"], 2);
    assert_eq!(report["introducedCycles"][0]["memberCount"], 2);
}

#[test]
fn staged_resolution_ignores_unstaged_metadata_bytes() {
    let fixture = cycle_module_fixture();
    fixture.write("go.mod", "module example.com/new\n");
    git(fixture.repo(), &["add", "go.mod"]);
    fixture.write("go.mod", "module example.com/old\n");

    let staged = report(&sense_staged(fixture.repo(), fixture.cache(), true));
    assert_eq!(staged["status"], "partial", "{staged:#}");
    assert_eq!(staged["changedFiles"], 1);
    assert_eq!(staged["after"]["runtimeEdges"], 2);
    let worktree = worktree_report(&fixture);
    assert_eq!(worktree["after"]["runtimeEdges"], 0);
}

#[test]
fn package_interfaces_aggregate_on_one_logical_path() {
    let fixture = RepositoryFixture::new(&[
        (
            ".opcore.json",
            r#"{"schemaVersion":1,"sense":{"maxModuleExports":1}}"#,
        ),
        ("go.mod", "module example.com/project\n"),
        ("pkg/one.go", "package pkg\nfunc One() {}\n"),
        ("pkg/two.go", "package pkg\nfunc hidden() {}\n"),
    ]);
    fixture.write(
        "pkg/two.go",
        "package pkg\nfunc hidden() {}\nfunc Two() {}\n",
    );

    let report = worktree_report(&fixture);
    assert_eq!(report["status"], "findings", "{report:#}");
    let finding = report["interfaceFindings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|finding| finding["code"] == "sense.interface.module_exports")
        .unwrap();
    assert_eq!(finding["path"], "pkg/one.go");
    assert_eq!(finding["before"], 1);
    assert_eq!(finding["after"], 2);
}

fn cycle_module_fixture() -> RepositoryFixture {
    RepositoryFixture::new(&[
        ("go.mod", "module example.com/old\n"),
        (
            "a/a.go",
            "package a\nimport \"example.com/new/b\"\nfunc A() { b.B() }\n",
        ),
        (
            "b/b.go",
            "package b\nimport \"example.com/new/a\"\nfunc B() { a.A() }\n",
        ),
    ])
}

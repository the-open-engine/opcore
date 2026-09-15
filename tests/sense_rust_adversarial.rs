#![cfg(unix)]

use std::{fmt::Write as _, fs, path::Path, thread};

use serde_json::Value;

mod support;
use support::{
    RepositoryFixture, assert_region_duplicate, blocking_sense, git, json, sense,
    sense_advisory_allow_partial, write_source as write,
};

fn initialize(repo: &Path, path: &str, source: &str) {
    fs::create_dir_all(repo).unwrap();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.name", "Test"]);
    git(repo, &["config", "user.email", "test@example.com"]);
    write(repo, path, source);
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "initial"]);
}

fn body(indentation: &str) -> String {
    let mut lines = vec![format!("{indentation}let mut accumulator = input;")];
    for value in 1..=12 {
        lines.push(format!(
            "{indentation}accumulator = accumulator.wrapping_add(input.wrapping_mul({value}));"
        ));
    }
    lines.push(format!("{indentation}accumulator"));
    lines.join("\n")
}

fn baseline_source() -> String {
    format!(
        "pub mod arithmetic {{\n    pub fn baseline(input: u64) -> u64 {{\n{}\n    }}\n}}\n",
        body("        ")
    )
}

fn candidate_source(name: &str) -> String {
    format!(
        concat!(
            "pub struct Worker;\n\nimpl Worker {{\n",
            "    // Formatting and owner differ; only the body is exact.\n",
            "    pub(crate) fn {name}(input:u64)->u64 {{ {} }}\n}}\n",
        ),
        body("        "),
        name = name,
    )
}

fn macro_negative_control() -> String {
    format!(
        concat!(
            "macro_rules! body_tokens_are_opaque {{\n",
            "    ($input:expr) => {{{{\n{}\n    }}}};\n}}\n\n",
            "pub(crate) use body_tokens_are_opaque;\n",
        ),
        body("        ").replace("input", "$input")
    )
}

fn rust_partial_region(name: &str, prefix: &str, suffix: &str) -> String {
    let mut source = format!(
        "pub fn {name}(values: &[u64]) -> u64 {{\n    let mut total = values.len() as u64;\n    {prefix};\n"
    );
    for index in 0..16 {
        writeln!(source, "    total = total.wrapping_add(values[{index}]);").unwrap();
    }
    writeln!(source, "    {suffix};\n    total\n}}").unwrap();
    source
}

#[test]
fn rust_partial_region_is_detected_without_a_callable_cascade() {
    let fixture = RepositoryFixture::new(&[(
        "src/lib.rs",
        &rust_partial_region("alpha", "let alpha_only = 1", "drop(alpha_only)"),
    )]);
    fixture.write(
        "src/copy.rs",
        &rust_partial_region(
            "beta",
            "let beta_only = values[0] * 2",
            "println!(\"{beta_only}\")",
        ),
    );

    let report = blocking_sense(fixture.repo(), fixture.cache());
    assert_region_duplicate(&report, "rust", 1, 2);
}

fn assert_duplicate(report: &Value, before_count: u64, after_count: u64, changed: &str) {
    let duplicates = report["introducedDuplicates"].as_array().unwrap();
    assert_eq!(duplicates.len(), 1, "{duplicates:?}");
    let duplicate = &duplicates[0];
    assert_eq!(duplicate["kind"], "callable_body");
    assert_eq!(duplicate["languageFamily"], "rust");
    assert_eq!(duplicate["beforeCount"], before_count);
    assert_eq!(duplicate["afterCount"], after_count);
    assert_eq!(duplicate["introducedCount"], after_count - before_count);
    assert!(duplicate["tokenCount"].as_u64().unwrap() >= 48);
    assert!(duplicate.get("bytes").is_none());

    let occurrences = duplicate["occurrences"].as_array().unwrap();
    assert_eq!(occurrences.len(), usize::try_from(after_count).unwrap());
    assert_eq!(occurrences[0]["path"], changed);
    assert_eq!(occurrences[0]["changed"], true);
    for occurrence in occurrences {
        assert_eq!(occurrence["callableKind"], "function");
        let start = occurrence["range"]["start"]["byte"].as_u64().unwrap();
        let end = occurrence["range"]["end"]["byte"].as_u64().unwrap();
        assert!(end > start, "{occurrence:?}");
    }
}

#[test]
fn rust_module_dependencies_are_structural_bounded_and_cycle_safe() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(&repo, "src/lib.rs", "mod a;\nmod b;\n");
    write(&repo, "src/a.rs", "pub struct A;\n");
    write(
        &repo,
        "src/b.rs",
        "use crate::a::A;\npub struct B(pub A);\n",
    );
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "module baseline"]);

    write(
        &repo,
        "src/a.rs",
        "use crate::b::B;\npub struct A(pub Option<B>);\n",
    );
    let result = sense(&repo, &cache, false);
    assert_eq!(result.status.code(), Some(1));
    let report = json(&result);

    assert_eq!(report["status"], "partial");
    assert_eq!(report["after"]["runtimeEdges"], 0);
    assert_eq!(report["after"]["typeOnlyEdges"], 0);
    assert_eq!(report["after"]["structuralEdges"], 4);
    assert_eq!(report["after"]["coverage"]["completeFiles"], 3);
    assert_eq!(report["after"]["coverage"]["unsupportedFiles"], 0);
    assert_eq!(report["after"]["coverage"]["structuralReferences"], 4);
    assert_eq!(report["after"]["coverage"]["resolvedReferences"], 4);
    assert!(report["introducedCycles"].as_array().unwrap().is_empty());
    assert_eq!(
        report["observations"]["dependencyDeltas"][0]["structuralDelta"],
        1
    );
}

#[test]
fn rust_dependency_target_growth_enforces_the_existing_interface_limit() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(&repo, "src/lib.rs", "mod hub;\n");
    let mut hub = String::new();
    for index in 0..20 {
        writeln!(hub, "mod dependency_{index};").unwrap();
        write(
            &repo,
            &format!("src/hub/dependency_{index}.rs"),
            &format!("pub struct Value{index};\n"),
        );
    }
    write(&repo, "src/hub.rs", &hub);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "dependency baseline"]);

    hub.push_str("mod dependency_20;\n");
    write(&repo, "src/hub.rs", &hub);
    write(&repo, "src/hub/dependency_20.rs", "pub struct Value20;\n");
    let result = sense(&repo, &cache, false);
    assert_eq!(result.status.code(), Some(1));
    let report = json(&result);

    let finding = report["interfaceFindings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|finding| finding["code"] == "sense.interface.dependency_targets")
        .expect("Rust dependency target finding");
    assert_eq!(finding["path"], "src/hub.rs");
    assert_eq!(finding["before"], 20);
    assert_eq!(finding["after"], 21);
    assert_eq!(finding["limit"], 20);
}

#[test]
fn rust_structural_fan_in_triggers_exact_documentation_ownership() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    let mut root = String::from("mod target;\n");
    for index in 0..8 {
        writeln!(root, "mod caller_{index};").unwrap();
    }
    initialize(&repo, "src/lib.rs", &root);
    write(&repo, "src/target.rs", "pub struct Target;\n");
    for index in 0..8 {
        write(
            &repo,
            &format!("src/caller_{index}.rs"),
            "use crate::target::Target;\npub fn consume(_: Target) {}\n",
        );
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "fan-in baseline"]);

    root.push_str("mod caller_8;\n");
    write(&repo, "src/lib.rs", &root);
    write(
        &repo,
        "src/caller_8.rs",
        "use crate::target::Target;\npub fn consume(_: Target) {}\n",
    );
    write(
        &repo,
        "src/target.rs",
        "// Agent-visible contract change.\npub struct Target;\n",
    );
    let result = sense(&repo, &cache, false);
    assert_eq!(result.status.code(), Some(1));
    let report = json(&result);

    let important = report["observations"]["importantNodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["path"] == "src/target.rs")
        .expect("important Rust target");
    assert_eq!(important["beforeConfirmedDependencyFanIn"], 9);
    assert_eq!(important["afterConfirmedDependencyFanIn"], 10);
    assert_eq!(important["newlyImportant"], true);
    let requirement = report["documentationRequirements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|requirement| requirement["path"] == "src/target.rs")
        .expect("documentation requirement");
    assert_eq!(requirement["code"], "sense.documentation.missing_binding");
    assert_eq!(requirement["reasons"][0], "newly_important");
}

#[test]
fn linked_rust_worktrees_share_facts_without_sharing_module_resolution() {
    let temp = tempfile::tempdir().unwrap();
    let main = temp.path().join("main");
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    let cache = temp.path().join("cache");
    initialize(&main, "src/lib.rs", "mod target;\nmod left;\nmod right;\n");
    write(&main, "src/target.rs", "pub struct Target;\n");
    write(
        &main,
        "src/left.rs",
        "use crate::target::Target;\npub struct Left(pub Target);\n",
    );
    write(&main, "src/right.rs", "pub struct Right;\n");
    git(&main, &["add", "."]);
    git(&main, &["commit", "-qm", "Rust worktree baseline"]);
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "rust-first",
            first.to_str().unwrap(),
        ],
    );
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "rust-second",
            second.to_str().unwrap(),
        ],
    );
    write(
        &first,
        "src/right.rs",
        "use crate::target::Target;\npub struct Right(pub Target);\n",
    );
    write(
        &second,
        "src/left.rs",
        "use super::super::Missing;\npub struct Left(pub Missing);\n",
    );

    let run_pair = || {
        thread::scope(|scope| {
            let first_run = scope.spawn(|| sense(&first, &cache, false));
            let second_run = scope.spawn(|| sense(&second, &cache, false));
            (first_run.join().unwrap(), second_run.join().unwrap())
        })
    };
    let cold = run_pair();
    let warm = run_pair();
    for pair in [&cold, &warm] {
        assert_eq!(pair.0.status.code(), Some(1));
        assert_eq!(pair.1.status.code(), Some(1));
        let first_report = json(&pair.0);
        let second_report = json(&pair.1);
        assert_eq!(first_report["after"]["structuralEdges"], 5);
        assert_eq!(first_report["after"]["coverage"]["unresolvedReferences"], 0);
        assert_eq!(second_report["after"]["structuralEdges"], 3);
        assert_eq!(
            second_report["after"]["coverage"]["unresolvedReferences"],
            1
        );
        assert_ne!(
            first_report["after"]["viewId"],
            second_report["after"]["viewId"]
        );
    }
    assert_eq!(json(&warm.0)["cache"]["misses"], 0);
    assert_eq!(json(&warm.1)["cache"]["misses"], 0);
}

#[test]
fn rust_callable_dedup_is_exact_introduced_only_advisory_and_macro_opaque() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(
        &repo,
        "crates/kernel/src/engine/arithmetic.rs",
        &baseline_source(),
    );

    write(
        &repo,
        "crates/consumer/src/nested/worker.rs",
        &candidate_source("candidate"),
    );
    write(
        &repo,
        "crates/consumer/src/nested/macros.rs",
        &macro_negative_control(),
    );

    let blocking = sense(&repo, &cache, false);
    assert_eq!(blocking.status.code(), Some(1));
    let first_report = json(&blocking);
    assert_eq!(first_report["status"], "partial");
    assert_duplicate(&first_report, 1, 2, "crates/consumer/src/nested/worker.rs");
    assert_eq!(
        first_report["dedupCoverage"]["after"]["callableOccurrences"],
        2
    );

    let repeated = sense(&repo, &cache, false);
    assert_eq!(repeated.status.code(), Some(1));
    assert_eq!(
        json(&repeated)["introducedDuplicates"],
        first_report["introducedDuplicates"]
    );

    let advisory = sense(&repo, &cache, true);
    assert_eq!(advisory.status.code(), Some(1));
    assert_eq!(json(&advisory)["status"], "partial");
    assert!(sense_advisory_allow_partial(&repo, &cache).status.success());

    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "accept duplicate debt"]);
    let debt = sense(&repo, &cache, false);
    assert_eq!(debt.status.code(), Some(0));
    assert_eq!(json(&debt)["status"], "partial");
    assert!(
        json(&debt)["introducedDuplicates"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    write(
        &repo,
        "crates/third/src/deeper/worker.rs",
        &candidate_source("third_copy"),
    );
    let expanded = sense(&repo, &cache, false);
    assert_eq!(expanded.status.code(), Some(1));
    let expanded_report = json(&expanded);
    assert_duplicate(&expanded_report, 2, 3, "crates/third/src/deeper/worker.rs");
}

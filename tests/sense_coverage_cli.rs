#![cfg(unix)]

use std::fmt::Write as _;

use serde_json::Value;

mod support;
use support::{RepositoryFixture, git, json, opcore, opcore_json};

#[test]
fn empty_staged_sense_keeps_baseline_gaps_visible_without_blocking() {
    let fixture = RepositoryFixture::new(&[(
        "main.mjs",
        "import { readFile } from 'node:fs/promises';\nexport { readFile };\n",
    )]);
    let empty = opcore_json(&fixture, "sense", &["--staged"]);
    assert!(empty.status.success());
    let empty = json(&empty);
    assert_eq!(empty["status"], "partial");
    assert_eq!(empty["changedFiles"], 0);
    assert_eq!(empty["after"]["coverage"]["nodeBuiltinReferences"], 1);

    let human = opcore(fixture.repo(), fixture.cache(), "sense", &["--staged"]);
    assert!(human.status.success());
    let human = String::from_utf8_lossy(&human.stdout);
    assert!(
        human.contains("baseline coverage remains partial"),
        "{human}"
    );
    assert!(!human.contains("rerun with --allow-partial"), "{human}");

    fixture.write(
        "main.mjs",
        "import { readFile } from 'node:fs/promises';\nexport const changed = readFile;\n",
    );
    git(fixture.repo(), &["add", "main.mjs"]);
    let changed = opcore_json(&fixture, "sense", &["--staged"]);
    assert!(!changed.status.success());
    assert_eq!(json(&changed)["changedFiles"], 1);
}

#[test]
fn node_builtin_acknowledgment_does_not_accept_other_resolution_gaps() {
    let fixture = RepositoryFixture::new(&[
        ("local.mjs", "export const value = 42;\n"),
        (
            "main.mjs",
            "import { value } from './local.mjs';\nexport { value };\n",
        ),
    ]);
    let local = opcore_json(&fixture, "sense", &[]);
    assert!(local.status.success());
    let local = json(&local);
    assert_eq!(local["status"], "clean");
    assert_eq!(local["after"]["coverage"]["resolvedReferences"], 1);
    assert_eq!(local["after"]["coverage"]["externalReferences"], 0);

    fixture.write(
        "main.mjs",
        concat!(
            "import { value } from './local.mjs';\n",
            "import { readFile } from 'node:fs/promises';\n",
            "export { value, readFile };\n",
        ),
    );

    let default = opcore_json(&fixture, "sense", &[]);
    assert!(!default.status.success());
    assert!(
        String::from_utf8_lossy(&default.stderr).contains("--allow-node-builtins"),
        "{}",
        String::from_utf8_lossy(&default.stderr)
    );
    let default = json(&default);
    assert_eq!(default["status"], "partial");
    assert_eq!(default["after"]["coverage"]["resolvedReferences"], 1);
    assert_eq!(default["after"]["resolutionGaps"][0]["path"], "main.mjs");
    assert_eq!(
        default["after"]["resolutionGaps"][0]["specifier"],
        "node:fs/promises"
    );
    assert_eq!(
        default["after"]["resolutionGaps"][0]["kind"],
        "node_builtin"
    );

    let builtin = opcore_json(&fixture, "sense", &["--allow-node-builtins"]);
    assert!(builtin.status.success());
    let builtin = json(&builtin);
    assert_eq!(builtin["status"], "partial");
    assert_eq!(builtin["after"]["coverage"]["nodeBuiltinReferences"], 1);
    assert_eq!(builtin["after"]["coverage"]["externalReferences"], 1);

    let human = opcore(fixture.repo(), fixture.cache(), "sense", &[]);
    assert!(!human.status.success());
    let human_stdout = String::from_utf8_lossy(&human.stdout);
    assert!(
        human_stdout.contains("node built-in: main.mjs"),
        "{human_stdout}"
    );
    assert!(
        human_stdout.contains("--allow-node-builtins"),
        "{human_stdout}"
    );

    fixture.write(
        "main.mjs",
        concat!(
            "import { readFile } from 'node:fs/promises';\n",
            "import missing from './missing.mjs';\n",
            "export { readFile, missing };\n",
        ),
    );
    let missing = opcore_json(&fixture, "sense", &["--allow-node-builtins"]);
    assert!(!missing.status.success());
    assert_eq!(
        json(&missing)["after"]["coverage"]["unresolvedReferences"],
        1
    );

    fixture.write(
        "main.mjs",
        "import package_value from 'third-party';\nexport { package_value };\n",
    );
    let package = opcore_json(&fixture, "sense", &["--allow-node-builtins"]);
    assert!(!package.status.success());
    assert_eq!(json(&package)["after"]["coverage"]["externalReferences"], 1);
}

#[test]
fn resolution_gap_evidence_is_bounded_and_deterministic() {
    let fixture = RepositoryFixture::new(&[("main.mjs", "export const before = true;\n")]);
    fixture.write(
        "main.mjs",
        concat!(
            "import 'node:zlib';\n",
            "import 'node:url';\n",
            "import 'node:tty';\n",
            "import 'node:tls';\n",
            "import 'node:timers/promises';\n",
            "import 'node:stream/web';\n",
            "export const after = true;\n",
        ),
    );

    let output = opcore_json(&fixture, "sense", &["--allow-node-builtins"]);
    assert!(output.status.success());
    let report = json(&output);
    let gaps = report["after"]["resolutionGaps"].as_array().unwrap();
    assert_eq!(gaps.len(), 5);
    assert_eq!(gaps[0]["specifier"], "node:stream/web");
    assert_eq!(gaps[4]["specifier"], "node:url");
    assert_eq!(report["after"]["resolutionGapsTruncated"], true);
}

#[test]
fn unknown_node_scheme_name_is_not_acknowledged_as_a_builtin() {
    let fixture = RepositoryFixture::new(&[("main.mjs", "export const before = true;\n")]);
    fixture.write(
        "main.mjs",
        "import value from 'node:not-real';\nexport { value };\n",
    );

    let output = opcore_json(&fixture, "sense", &["--allow-node-builtins"]);
    assert!(!output.status.success());
    let report = json(&output);
    assert_eq!(report["status"], "partial");
    assert_eq!(report["after"]["coverage"]["nodeBuiltinReferences"], 0);
    assert_eq!(report["after"]["coverage"]["externalReferences"], 1);
    assert_eq!(report["after"]["resolutionGaps"][0]["kind"], "external");
}

#[test]
fn duplicate_file_limit_reports_stage_limit_view_path_and_recovery() {
    let fixture = RepositoryFixture::new(&[("baseline.js", "export const baseline = true;\n")]);
    let mut source = String::from("let total = 0;\n");
    for index in 0..15_000 {
        writeln!(source, "total += {index};").unwrap();
    }
    fixture.write("large.js", &source);

    let output = opcore_json(&fixture, "sense", &[]);
    assert!(!output.status.success());
    let report = json(&output);
    assert_eq!(report["status"], "incomplete");
    let issue = report["issues"]
        .as_array()
        .unwrap()
        .iter()
        .find(|issue| issue["code"] == "dedup_region_file_limit")
        .unwrap();
    assert_eq!(issue["stage"], "token_region_file_extraction");
    assert_eq!(issue["views"], Value::from(vec!["after"]));
    assert_eq!(issue["limit"], 4_096);
    assert_eq!(issue["processed"], 4_096);
    assert_eq!(issue["paths"], Value::from(vec!["large.js"]));
    assert!(
        issue["nextStep"]
            .as_str()
            .unwrap()
            .contains("No runtime option")
    );
    assert!(
        issue["nextStep"]
            .as_str()
            .unwrap()
            .contains(r#"{"schemaVersion":1,"targets":{"exclude":["generated","vendor"]}}"#)
    );
    assert!(
        issue["nextStep"]
            .as_str()
            .unwrap()
            .contains("/v0.3/docs/configuration.html#select-targets")
    );
}

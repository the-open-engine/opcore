use std::{collections::BTreeSet, fs};

use super::*;

fn write(root: &Path, configuration: &str) {
    fs::write(root.join(POLICY_PATH), configuration).unwrap();
}

fn git(root: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn repository(root: &Path) -> GitRepository {
    git(root, &["init", "-q"]);
    git(root, &["config", "user.name", "Configuration test"]);
    git(
        root,
        &["config", "user.email", "configuration@example.invalid"],
    );
    GitRepository::discover(root).unwrap()
}

#[test]
fn workflow_fields_inherit_and_arrays_replace_without_touching_other_workflows() {
    let root = tempfile::tempdir().unwrap();
    let repo = repository(root.path());
    write(
        root.path(),
        r#"{
      "schemaVersion":1,"verify":{"maxParameters":6,"maxNesting":5},
      "targets":{"exclude":["vendor","legacy"]},
      "native":["rust-native"],
      "providers":{"rust-native":{"roots":["crates/core"]}},
      "workflows":{
        "post-edit":{"verify":{"maxParameters":8},"targets":{"exclude":[]}},
        "pre-commit":{"verify":{"maxParameters":3},"native":[]},
        "ci":{"targets":{"exclude":["vendor"]},"providers":{"rust-native":{"roots":["crates/api"]}}}
      }
    }"#,
    );
    let post =
        PolicySnapshot::capture(&repo, ConfigView::Worktree, Some(Workflow::PostEdit)).unwrap();
    assert_eq!(post.policy.verify.max_parameters, 8);
    assert_eq!(post.policy.verify.max_nesting, 5);
    assert!(post.policy.targets.exclude.is_empty());
    assert!(post.policy.native.is_empty());
    assert!(post.policy.coverage.allow_partial);
    assert_eq!(post.origins["/verify/maxParameters"], "workflow:post-edit");
    assert_eq!(post.origins["/verify/maxNesting"], "repository");
    let pre =
        PolicySnapshot::capture(&repo, ConfigView::Worktree, Some(Workflow::PreCommit)).unwrap();
    assert_eq!(pre.policy.verify.max_parameters, 3);
    assert_eq!(pre.policy.targets.exclude.len(), 2);
    assert!(pre.policy.native.is_empty());
    assert!(!pre.policy.coverage.allow_partial);
    let ci = PolicySnapshot::capture(&repo, ConfigView::Worktree, Some(Workflow::Ci)).unwrap();
    assert_eq!(ci.policy.providers.rust_native.roots, ["crates/api"]);
    assert_eq!(ci.policy.native, [NativeProvider::RustNative]);
    assert_eq!(ci.policy.targets.exclude[0].as_utf8(), Some("vendor"));
}

#[test]
fn strict_post_edit_coverage_is_an_explicit_override() {
    let root = tempfile::tempdir().unwrap();
    let repo = repository(root.path());
    for configuration in [
        r#"{"schemaVersion":1,"coverage":{"allowPartial":false}}"#,
        r#"{"schemaVersion":1,"workflows":{"post-edit":{"coverage":{"allowPartial":false}}}}"#,
    ] {
        write(root.path(), configuration);
        let snapshot =
            PolicySnapshot::capture(&repo, ConfigView::Worktree, Some(Workflow::PostEdit)).unwrap();
        assert!(!snapshot.policy.coverage.allow_partial);
    }
}

#[test]
fn selected_git_view_controls_configuration_and_freshness() {
    let root = tempfile::tempdir().unwrap();
    let repo = repository(root.path());
    write(
        root.path(),
        r#"{"schemaVersion":1,"verify":{"maxParameters":3}}"#,
    );
    git(root.path(), &["add", "."]);
    git(root.path(), &["commit", "-qm", "base"]);
    git(root.path(), &["branch", "baseline"]);
    write(
        root.path(),
        r#"{"schemaVersion":1,"verify":{"maxParameters":5}}"#,
    );
    git(root.path(), &["add", "."]);
    write(root.path(), "{ malformed unstaged bytes");
    let staged = PolicySnapshot::capture(&repo, ConfigView::Index, None).unwrap();
    assert_eq!(staged.policy.verify.max_parameters, 5);
    let tree = PolicySnapshot::capture(&repo, ConfigView::Tree("baseline".into()), None).unwrap();
    assert_eq!(tree.policy.verify.max_parameters, 3);
    assert!(PolicySnapshot::capture(&repo, ConfigView::Worktree, None).is_err());
    write(
        root.path(),
        r#"{"schemaVersion":1,"verify":{"maxParameters":7}}"#,
    );
    assert!(staged.is_current().unwrap());
    assert!(tree.is_current().unwrap());
    git(root.path(), &["add", "."]);
    assert!(!staged.is_current().unwrap());
    git(root.path(), &["commit", "-qm", "new"]);
    git(root.path(), &["branch", "-f", "baseline", "HEAD"]);
    assert!(!tree.is_current().unwrap());
}

#[test]
fn malformed_unused_workflows_and_unsafe_paths_are_never_ignored() {
    for invalid in [
        r#"{"schemaVersion":1,"workflows":{"other":{}}}"#,
        r#"{"schemaVersion":1,"workflows":{"ci":{"verify":{"maxParameters":null}}}}"#,
        r#"{"schemaVersion":1,"workflows":{"ci":{"verify":{"maxParameters":0,"maxParameters":2}}}}"#,
        r#"{"schemaVersion":1,"workflows":{"ci":{"documentation":{"bindings":[]}}}}"#,
        r#"{"schemaVersion":1,"workflows":{"post-edit":{"native":["rust-native"]}}}"#,
        r#"{"schemaVersion":1,"targets":{"exclude":["../outside"]}}"#,
        r#"{"schemaVersion":1,"providers":{"node-native":{"roots":["apps","apps/web"]}}}"#,
    ] {
        assert!(parse_policy(invalid.as_bytes()).is_err(), "{invalid}");
    }
}

#[test]
fn invalid_nested_settings_name_the_exact_file_and_field() {
    for (configuration, pointer) in [
        (
            r#"{"schemaVersion":1,"workflows":{"pre-commit":{"verify":{"maxParameters":"many"}}}}"#,
            "/workflows/pre-commit/verify/maxParameters",
        ),
        (
            r#"{"schemaVersion":1,"targets":{"exclude":["../outside"]}}"#,
            "/targets/exclude/0",
        ),
        (
            r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":false,"document":"guide.md"}]}}"#,
            "/documentation/bindings/0/source",
        ),
    ] {
        let error = parse_policy(configuration.as_bytes())
            .unwrap_err()
            .to_string();
        assert!(error.contains(POLICY_PATH), "{error}");
        assert!(error.contains(pointer), "{error}");
    }
}

#[test]
fn hypothetical_documentation_cannot_change_an_unselected_workflow() {
    let root = tempfile::tempdir().unwrap();
    let repo = repository(root.path());
    let current =
        PolicySnapshot::capture(&repo, ConfigView::Worktree, Some(Workflow::PostEdit)).unwrap();
    assert!(current.validate_hypothetical(Some(br#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/a.ts","document":"docs/a.md"}]}}"#)).is_ok());
    assert!(
        current
            .validate_hypothetical(Some(
                br#"{"schemaVersion":1,"workflows":{"pre-commit":{"verify":{"maxParameters":1}}}}"#
            ))
            .is_err()
    );
}

#[test]
fn semantic_digest_ignores_formatting_and_exclusions_are_literal_boundaries() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        r#"{"schemaVersion":1,"targets":{"exclude":["legacy","literal[*].ts"]}}"#,
    );
    let first = PolicySnapshot::load(root.path()).unwrap();
    write(
        root.path(),
        "{\n \"targets\":{\"exclude\":[\"legacy\",\"literal[*].ts\"]}, \"schemaVersion\":1 }\n",
    );
    let second = PolicySnapshot::load(root.path()).unwrap();
    assert_eq!(first.digest, second.digest);
    assert!(!first.is_current().unwrap());
    let targets = &second.policy.targets;
    for path in ["legacy.ts", "legacy-utils/a.ts", "literal1.ts"] {
        assert!(targets.includes(&RepoPath::from_protocol(path).unwrap()));
    }
    for path in ["legacy", "legacy/a.ts", "literal[*].ts"] {
        assert!(!targets.includes(&RepoPath::from_protocol(path).unwrap()));
    }
    assert_eq!(
        schema()["properties"]["verify"]["properties"]["maxNesting"]["maximum"],
        MAX_STRUCTURAL_DEPTH
    );
    assert_eq!(
        schema()["properties"]["sense"]["properties"]["importantFanIn"]["minimum"],
        1
    );
    assert!(schema()["properties"]["workflows"]["properties"]["ci"]["properties"]["verify"]["properties"]["maxParameters"].get("default").is_none());
    assert_eq!(
        schema()["properties"]["workflows"]["properties"]["post-edit"]["properties"]["native"]["maxItems"],
        0
    );
}

#[test]
fn workflow_observation_detects_auxiliary_changes_without_reading_oversized_contents() {
    let root = tempfile::tempdir().unwrap();
    let repo = repository(root.path());
    fs::write(root.path().join("a.ts"), "export const a = 1;\n").unwrap();
    fs::write(root.path().join("guide.md"), "original").unwrap();
    let paths = BTreeSet::from([RepoPath::from_protocol("guide.md").unwrap()]);
    let before = repo
        .observation_with_auxiliary(&ConfigView::Worktree, None, &paths)
        .unwrap();
    fs::write(
        root.path().join("guide.md"),
        vec![b'x'; MAX_SOURCE_BYTES + 1],
    )
    .unwrap();
    let after = repo
        .observation_with_auxiliary(&ConfigView::Worktree, None, &paths)
        .unwrap();
    assert_ne!(before, after);
}

#[test]
fn missing_policy_is_default_and_exact_config_is_strict() {
    let root = tempfile::tempdir().unwrap();
    let default = PolicySnapshot::load(root.path()).unwrap();
    assert_eq!(default.state, PolicyState::Default);
    fs::write(
        root.path().join(POLICY_PATH),
        r#"{"schemaVersion":1,"verify":{"maxParameters":2}}"#,
    )
    .unwrap();
    let configured = PolicySnapshot::load(root.path()).unwrap();
    assert_eq!(configured.state, PolicyState::Configured);
    assert_eq!(configured.policy.verify.max_parameters, 2);
    assert_ne!(configured.digest, default.digest);
    assert!(!default.is_current().unwrap());
}

#[test]
fn rejects_unknown_duplicate_unsafe_and_oversized_policy() {
    let root = tempfile::tempdir().unwrap();
    for invalid in [
        r#"{"schemaVersion":1,"unknown":true}"#,
        r#"{"schemaVersion":1,"schemaVersion":1}"#,
        r#"{"schemaVersion":3}"#,
        r#"{"schemaVersion":1,"providers":{"external":{"example":{"configuration":{}}}}}"#,
        r#"{"schemaVersion":1,"verify":{"maxLineBytes":1048577}}"#,
        r#"{"schemaVersion":1,"sense":{"importantFanIn":0}}"#,
    ] {
        fs::write(root.path().join(POLICY_PATH), invalid).unwrap();
        assert!(PolicySnapshot::load(root.path()).is_err(), "{invalid}");
    }
    fs::write(
        root.path().join(POLICY_PATH),
        vec![b' '; MAX_POLICY_BYTES + 1],
    )
    .unwrap();
    assert!(PolicySnapshot::load(root.path()).is_err());
}

#[test]
fn schema_two_keeps_external_rules_with_workflow_selection() {
    let policy = parse_policy(
        br#"{
        "schemaVersion":2,
        "providers":{"external":{"example-ast-grep":{"configuration":{"rules":[{
            "id":"redundant-branch","language":"python","severity":"error",
            "message":"Simplify this branch","rule":{"pattern":"return True"}
        }]}}}},
        "workflows":{"post-edit":{"external":["example-ast-grep"]}}
    }"#,
    )
    .unwrap();
    assert!(policy.external.is_empty());
    let effective = policy.resolve(Some(Workflow::PostEdit)).unwrap();
    assert_eq!(effective.external, ["example-ast-grep"]);
    assert_eq!(
        effective.providers.external["example-ast-grep"].configuration["rules"][0]["id"],
        "redundant-branch"
    );
    assert!(parse_policy(br#"{"schemaVersion":2,"external":["missing"]}"#).is_err());
}

#![cfg(unix)]

use std::{
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

use serde_json::Value;

mod support;
use support::{RepositoryFixture, assert_clean_sense, assert_region_duplicate, blocking_sense};

fn git(repo: &Path, args: &[&str]) {
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
}

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

fn sense(repo: &Path, cache: &Path, advisory: bool) -> Output {
    let options: &[&str] = if advisory { &["--advisory"] } else { &[] };
    sense_with_options(repo, cache, options.iter().copied())
}

fn sense_with_options<'a>(
    repo: &Path,
    cache: &Path,
    options: impl IntoIterator<Item = &'a str>,
) -> Output {
    let mut command = Command::new(assert_cmd::cargo::cargo_bin!("opcore"));
    command
        .args(["sense", "--repo"])
        .arg(repo)
        .arg("--json")
        .args(options)
        .env("XDG_CACHE_HOME", cache);
    command.output().unwrap()
}

fn sense_allow_partial(repo: &Path, cache: &Path) -> Output {
    sense_with_options(repo, cache, ["--allow-partial"])
}

fn sense_advisory_allow_partial(repo: &Path, cache: &Path) -> Output {
    sense_with_options(repo, cache, ["--advisory", "--allow-partial"])
}

fn sense_staged(repo: &Path, cache: &Path, advisory: bool) -> Output {
    let mut command = Command::new(assert_cmd::cargo::cargo_bin!("opcore"));
    command
        .args(["sense", "--repo"])
        .arg(repo)
        .args(["--staged", "--json"])
        .env("XDG_CACHE_HOME", cache);
    if advisory {
        command.arg("--advisory");
    }
    command.output().unwrap()
}

fn json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "invalid JSON: {error}\nstdout={}\nstderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

fn accept_duplicate_debt(repo: &Path, cache: &Path, message: &str) {
    assert!(sense(repo, cache, true).status.success());
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", message]);
    assert_clean_sense(repo, cache);
}

fn repository_paths() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    (temp, repo, cache)
}

#[test]
fn staged_sense_uses_only_the_complete_stage_zero_index() {
    let (_temp, repo, cache) = repository_paths();
    initialize(
        &repo,
        &[
            ("src/a.ts", "import './b';\nexport const a = 1;\n"),
            ("src/b.ts", "export const b = 1;\n"),
        ],
    );

    fs::write(
        repo.join("src/b.ts"),
        "import './a';\nexport const b = 1;\n",
    )
    .unwrap();
    git(&repo, &["add", "src/b.ts"]);
    fs::write(repo.join("src/b.ts"), "export const b = 2;\n").unwrap();
    fs::write(
        repo.join("src/untracked.ts"),
        "import './a';\nexport const untracked = true;\n",
    )
    .unwrap();

    let staged_bad = sense_staged(&repo, &cache, false);
    assert!(!staged_bad.status.success());
    let report = json(&staged_bad);
    assert_eq!(report["status"], "findings");
    assert_eq!(report["changedFiles"], 1);
    assert_eq!(report["after"]["files"], 2);
    let valid_as_of: Value = serde_json::from_str(report["validAsOf"].as_str().unwrap()).unwrap();
    assert_eq!(valid_as_of["source"]["kind"], "git-sense-input");
    let source_valid_as_of: Value =
        serde_json::from_str(valid_as_of["source"]["source"].as_str().unwrap()).unwrap();
    assert_eq!(source_valid_as_of["kind"], "git-index");

    let worktree_repair = sense(&repo, &cache, false);
    assert!(worktree_repair.status.success());
    assert_eq!(json(&worktree_repair)["status"], "clean");

    git(&repo, &["reset", "--hard", "-q", "HEAD"]);
    fs::write(
        repo.join("src/b.ts"),
        "import './a';\nexport const b = 1;\n",
    )
    .unwrap();
    let staged_clean = sense_staged(&repo, &cache, false);
    assert!(staged_clean.status.success());
    assert_eq!(json(&staged_clean)["status"], "clean");
    let dirty_bad = sense(&repo, &cache, false);
    assert!(!dirty_bad.status.success());
    assert_eq!(json(&dirty_bad)["status"], "findings");
}

#[test]
fn staged_documentation_reads_index_registry_and_document_bytes() {
    let (_temp, repo, cache) = repository_paths();
    initialize(
        &repo,
        &[
            ("src/core.ts", "export const core = 1;\n"),
            (
                ".opcore.json",
                r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/core.ts","document":"docs/core.md"}]}}"#,
            ),
            ("docs/core.md", "Core export.\n"),
        ],
    );
    for index in 0..10 {
        fs::write(
            repo.join(format!("src/importer-{index}.ts")),
            "import './core';\nexport const importer = true;\n",
        )
        .unwrap();
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "important core"]);

    fs::write(repo.join("src/core.ts"), "export const renamed = 1;\n").unwrap();
    git(&repo, &["add", "src/core.ts"]);
    fs::write(repo.join("docs/core.md"), "Dirty repair only.\n").unwrap();
    let stale_stage = sense_staged(&repo, &cache, false);
    assert!(!stale_stage.status.success());
    assert_eq!(
        json(&stale_stage)["documentationRequirements"][0]["code"],
        "sense.documentation.document_not_updated"
    );

    fs::write(
        repo.join(".opcore.json"),
        r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/core.ts","document":"docs/staged.md"}]}}"#,
    )
    .unwrap();
    fs::write(repo.join("docs/staged.md"), "Staged renamed export.\n").unwrap();
    git(&repo, &["add", ".opcore.json", "docs/staged.md"]);
    fs::write(repo.join(".opcore.json"), "{ dirty malformed").unwrap();
    fs::write(repo.join("docs/staged.md"), "dirty stale bytes\n").unwrap();

    let exact_stage = sense_staged(&repo, &cache, false);
    assert!(exact_stage.status.success());
    let report = json(&exact_stage);
    assert_eq!(report["status"], "clean");
    assert_eq!(report["documentationCoverage"]["afterRegistry"], "valid");
    assert_eq!(report["documentationCoverage"]["changedDocuments"], 1);
    assert!(
        report["validAsOf"]
            .as_str()
            .unwrap()
            .contains("git-auxiliary-index")
    );
}

#[test]
fn linked_worktrees_keep_staged_sense_indexes_isolated() {
    let temp = tempfile::tempdir().unwrap();
    let main = temp.path().join("main");
    let linked = temp.path().join("linked");
    let cache = temp.path().join("cache");
    initialize(
        &main,
        &[
            ("src/a.ts", "import './b';\nexport const a = 1;\n"),
            ("src/b.ts", "export const b = 1;\n"),
        ],
    );
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "staged-linked",
            linked.to_str().unwrap(),
        ],
    );

    fs::write(
        main.join("src/b.ts"),
        "import './a';\nexport const b = 1;\n",
    )
    .unwrap();
    git(&main, &["add", "src/b.ts"]);
    fs::write(linked.join("src/b.ts"), "export const b = 2;\n").unwrap();

    let main_output = sense_staged(&main, &cache, false);
    let linked_output = sense_staged(&linked, &cache, false);
    assert!(!main_output.status.success());
    assert!(linked_output.status.success());
    let main_report = json(&main_output);
    let linked_report = json(&linked_output);
    assert_eq!(main_report["status"], "findings");
    assert_eq!(linked_report["status"], "clean");
    assert_ne!(main_report["validAsOf"], linked_report["validAsOf"]);
}

#[test]
fn runtime_cycles_are_introduced_only_and_type_edges_do_not_block() {
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

    let baseline = sense(&repo, &cache, false);
    assert!(baseline.status.success());
    assert_eq!(json(&baseline)["status"], "clean");

    fs::write(
        repo.join("src/b.ts"),
        "import type { a } from './a';\nexport const b = 1;\n",
    )
    .unwrap();
    let type_only = sense(&repo, &cache, false);
    assert!(type_only.status.success());
    assert_eq!(json(&type_only)["status"], "clean");
    assert_eq!(json(&type_only)["after"]["typeOnlyEdges"], 1);

    fs::write(
        repo.join("src/b.ts"),
        "import './a';\nexport const b = 1;\n",
    )
    .unwrap();
    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "findings");
    assert_eq!(report["introducedCycles"][0]["memberCount"], 2);
    assert_eq!(report["introducedCycles"][0]["trigger"]["from"], "src/b.ts");
    assert_eq!(report["introducedCycles"][0]["trigger"]["to"], "src/a.ts");
    assert!(sense(&repo, &cache, true).status.success());

    git(&repo, &["add", "src/b.ts"]);
    git(&repo, &["commit", "-qm", "baseline cycle"]);
    let existing_debt = sense(&repo, &cache, false);
    assert!(existing_debt.status.success());
    assert_eq!(json(&existing_debt)["status"], "clean");
}

#[test]
fn direct_common_js_require_edges_create_introduced_runtime_cycles() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(
        &repo,
        &[
            (
                "a.cjs",
                "const b = require(\"./b.cjs\");\nmodule.exports = b;\n",
            ),
            ("b.cjs", "module.exports = 42;\n"),
        ],
    );

    fs::write(
        repo.join("b.cjs"),
        "const a = require(\"./a.cjs\");\nmodule.exports = a;\n",
    )
    .unwrap();
    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "partial");
    assert_eq!(report["before"]["runtimeEdges"], 1);
    assert_eq!(report["after"]["runtimeEdges"], 2);
    assert_eq!(report["after"]["coverage"]["runtimeReferences"], 2);
    assert_eq!(report["after"]["coverage"]["resolvedReferences"], 2);
    assert_eq!(report["introducedCycles"][0]["memberCount"], 2);
    assert_eq!(report["introducedCycles"][0]["trigger"]["from"], "b.cjs");
    assert_eq!(report["introducedCycles"][0]["trigger"]["to"], "a.cjs");
}

#[test]
fn loop_reassignment_keeps_common_js_require_edges_partial_and_unconfirmed() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(
        &repo,
        &[
            ("target-a.cjs", "module.exports = 1;\n"),
            ("target-b.cjs", "module.exports = 2;\n"),
            ("target-c.cjs", "module.exports = 3;\n"),
            ("target-d.cjs", "module.exports = 4;\n"),
        ],
    );

    for (path, source) in [
        (
            "a.cjs",
            "for (require of loaders) {}\nconst value = require('./target-a.cjs');\n",
        ),
        (
            "b.cjs",
            "const value = require('./target-b.cjs');\nfor (require in loaders) {}\n",
        ),
        (
            "c.cjs",
            "for ([require] of loaderGroups) {}\nconst value = require('./target-c.cjs');\n",
        ),
        (
            "d.cjs",
            "const value = require('./target-d.cjs');\nfor ({ loader: require } in loaderGroups) {}\n",
        ),
    ] {
        fs::write(repo.join(path), source).unwrap();
    }

    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "partial");
    assert_eq!(report["after"]["runtimeEdges"], 0);
    assert_eq!(report["after"]["coverage"]["runtimeReferences"], 0);
    assert_eq!(report["after"]["coverage"]["resolvedReferences"], 0);
}

#[test]
fn ambiguity_is_not_an_edge_and_exact_copy_is_a_finding() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    let repeated = format!("export const repeated = '{}';\n", "x".repeat(300));
    initialize(
        &repo,
        &[
            ("src/a.ts", "import './target';\nexport const a = 1;\n"),
            ("src/target.ts", "export const target = 1;\n"),
            ("src/repeated.ts", &repeated),
        ],
    );

    fs::write(repo.join("src/target.js"), "export const target = 2;\n").unwrap();
    fs::write(repo.join("src/copy.ts"), &repeated).unwrap();
    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "partial");
    assert_eq!(report["after"]["coverage"]["ambiguousReferences"], 1);
    assert_eq!(report["after"]["runtimeEdges"], 0);
    assert_eq!(report["introducedDuplicates"][0]["beforeCount"], 1);
    assert_eq!(report["introducedDuplicates"][0]["afterCount"], 2);
    assert_eq!(report["introducedDuplicates"][0]["kind"], "identical_file");
    assert!(!sense(&repo, &cache, true).status.success());
    assert!(sense_advisory_allow_partial(&repo, &cache).status.success());
}

fn callable_source(name: &str) -> String {
    let statements = (0..20)
        .map(|value| format!("value += {value};"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("export function {name}() {{\nlet value = 0;\n{statements}\nreturn value;\n}}\n")
}

#[test]
fn exact_callable_copy_is_blocking_introduced_only_and_reports_ranges() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    let alpha = callable_source("alpha");
    let beta = callable_source("beta");
    initialize(&repo, &[("src/alpha.ts", &alpha)]);

    fs::write(repo.join("src/beta.ts"), beta).unwrap();
    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "findings");
    assert_eq!(report["introducedDuplicates"][0]["kind"], "callable_body");
    assert_eq!(report["introducedDuplicates"][0]["languageFamily"], "node");
    assert_eq!(report["introducedDuplicates"][0]["beforeCount"], 1);
    assert_eq!(report["introducedDuplicates"][0]["afterCount"], 2);
    assert_eq!(
        report["introducedDuplicates"][0]["occurrences"][0]["path"],
        "src/beta.ts"
    );
    assert_eq!(
        report["introducedDuplicates"][0]["occurrences"][0]["changed"],
        true
    );
    assert!(
        report["introducedDuplicates"][0]["occurrences"][0]["range"]["start"]["line"]
            .as_u64()
            .is_some()
    );
    accept_duplicate_debt(&repo, &cache, "accept duplicate debt");

    fs::write(repo.join("src/gamma.ts"), callable_source("gamma")).unwrap();
    let expanded_debt = sense(&repo, &cache, false);
    assert!(!expanded_debt.status.success());
    assert_eq!(
        json(&expanded_debt)["introducedDuplicates"][0]["beforeCount"],
        2
    );
    assert_eq!(
        json(&expanded_debt)["introducedDuplicates"][0]["afterCount"],
        3
    );
}

fn shared_token_block() -> String {
    (0..16).fold(String::new(), |mut source, index| {
        writeln!(source, "  shared = shared + inputs[{index}];").unwrap();
        source
    })
}

fn partial_block_source(name: &str, prefix: &str, suffix: &str) -> String {
    format!(
        concat!(
            "export function {name}(inputs: number[]) {{\n",
            "  let shared = inputs.length;\n  {prefix};\n{}",
            "  {suffix};\n  return shared;\n}}\n",
        ),
        shared_token_block(),
        name = name,
        prefix = prefix,
        suffix = suffix,
    )
}

#[test]
fn partial_token_region_is_one_blocking_introduced_only_finding() {
    let fixture = RepositoryFixture::new(&[(
        "src/alpha.ts",
        &partial_block_source("alpha", "const alphaOnly = 1", "void alphaOnly"),
    )]);
    let repo = fixture.repo();
    let cache = fixture.cache();

    fs::write(
        repo.join("src/beta.ts"),
        partial_block_source(
            "beta",
            "const betaOnly = inputs[0] * 2",
            "console.log(betaOnly)",
        ),
    )
    .unwrap();
    let report = blocking_sense(repo, cache);
    assert_eq!(report["status"], "findings");
    let duplicate = assert_region_duplicate(&report, "node", 1, 2);
    assert_eq!(duplicate["occurrences"][0]["path"], "src/beta.ts");
    assert_eq!(duplicate["occurrences"][0]["changed"], true);
    assert!(
        duplicate["occurrences"][0]["range"]["end"]["byte"]
            .as_u64()
            .unwrap()
            > duplicate["occurrences"][0]["range"]["start"]["byte"]
                .as_u64()
                .unwrap()
    );
    assert!(
        report["dedupCoverage"]["after"]["regionAnchors"]
            .as_u64()
            .is_some_and(|anchors| anchors > 0)
    );
    accept_duplicate_debt(repo, cache, "accept partial duplicate debt");

    fs::write(
        repo.join("src/gamma.ts"),
        partial_block_source("gamma", "const gammaOnly = 3", "void gammaOnly"),
    )
    .unwrap();
    let expanded = blocking_sense(repo, cache);
    assert_region_duplicate(&expanded, "node", 2, 3);
}

#[test]
fn exact_file_copy_emits_one_finding_without_callable_cascade() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    let source = callable_source("alpha");
    initialize(&repo, &[("src/alpha.ts", &source)]);

    fs::write(repo.join("src/copy.ts"), source).unwrap();
    let report = blocking_sense(&repo, &cache);
    let duplicates = report["introducedDuplicates"].as_array().unwrap();
    assert_eq!(duplicates.len(), 1);
    assert_eq!(duplicates[0]["kind"], "identical_file");
    assert_eq!(duplicates[0]["beforeCount"], 1);
    assert_eq!(duplicates[0]["afterCount"], 2);
}

#[test]
fn exact_rename_preserves_cycle_debt_and_deleted_impact_uses_the_before_graph() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(
        &repo,
        &[
            ("src/a.ts", "import './b';\nexport const a = 1;\n"),
            ("src/b.ts", "import './a';\nexport const b = 1;\n"),
        ],
    );

    git(&repo, &["mv", "src/a.ts", "src/renamed.ts"]);
    fs::write(
        repo.join("src/b.ts"),
        "import './renamed';\nexport const b = 1;\n",
    )
    .unwrap();
    let renamed = sense(&repo, &cache, false);
    assert!(renamed.status.success());
    assert_eq!(json(&renamed)["status"], "clean");
    assert!(
        json(&renamed)["introducedCycles"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    git(&repo, &["reset", "--hard", "-q", "HEAD"]);
    git(&repo, &["rm", "-q", "src/b.ts"]);
    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "partial");
    let impact = report["observations"]["impact"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["path"] == "src/b.ts")
        .unwrap();
    assert_eq!(impact["deleted"], true);
    assert_eq!(impact["confirmedDirectDependents"], 1);
}

#[test]
fn concurrent_linked_worktrees_share_facts_without_sharing_findings() {
    let temp = tempfile::tempdir().unwrap();
    let main = temp.path().join("main");
    let linked = temp.path().join("linked");
    let cache = temp.path().join("cache");
    initialize(
        &main,
        &[
            ("src/a.ts", "import './b';\nexport const a = 1;\n"),
            ("src/b.ts", "export const b = 1;\n"),
        ],
    );
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
    fs::write(
        main.join("src/b.ts"),
        "import './a';\nexport const b = 1;\n",
    )
    .unwrap();
    fs::write(
        linked.join("src/b.ts"),
        "import type { a } from './a';\nexport const b = 1;\n",
    )
    .unwrap();

    let spawn = |repo: &Path| {
        let mut child = Command::new(assert_cmd::cargo::cargo_bin!("opcore"));
        child
            .args(["sense", "--repo"])
            .arg(repo)
            .args(["--json", "--advisory"])
            .env("XDG_CACHE_HOME", &cache)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    };
    let mut first = spawn(&main);
    let mut second = spawn(&linked);
    assert!(first.wait().unwrap().success());
    assert!(second.wait().unwrap().success());

    let main_report = json(&sense(&main, &cache, true));
    let linked_report = json(&sense(&linked, &cache, false));
    assert_eq!(main_report["status"], "findings");
    assert_eq!(linked_report["status"], "clean");
    assert_eq!(main_report["cache"]["misses"], 0);
    assert_eq!(linked_report["cache"]["misses"], 0);
    assert_eq!(
        main_report["before"]["viewId"],
        linked_report["before"]["viewId"]
    );
    assert_ne!(
        main_report["after"]["viewId"],
        linked_report["after"]["viewId"]
    );
}

#[test]
fn concurrent_documentation_worktrees_keep_registry_and_documents_local() {
    let temp = tempfile::tempdir().unwrap();
    let main = temp.path().join("main");
    let linked = temp.path().join("linked");
    let cache = temp.path().join("cache");
    initialize(
        &main,
        &[
            ("src/core.ts", "export const core = 1;\n"),
            (
                ".opcore.json",
                r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/core.ts","document":"docs/core.md"}]}}"#,
            ),
            ("docs/core.md", "Core module ownership.\n"),
        ],
    );
    for index in 0..10 {
        fs::write(
            main.join(format!("src/importer-{index}.ts")),
            "import './core';\nexport const importer = true;\n",
        )
        .unwrap();
    }
    git(&main, &["add", "."]);
    git(&main, &["commit", "-qm", "important module"]);
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "docs-linked",
            linked.to_str().unwrap(),
        ],
    );
    for repo in [&main, &linked] {
        fs::write(repo.join("src/core.ts"), "export const renamed = 1;\n").unwrap();
    }
    fs::write(
        linked.join("docs/core.md"),
        "Core module ownership and renamed export.\n",
    )
    .unwrap();

    let spawn = |repo: &Path| {
        Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
            .args(["sense", "--repo"])
            .arg(repo)
            .args(["--json", "--advisory"])
            .env("XDG_CACHE_HOME", &cache)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    };
    let concurrent_pair = || {
        let main_child = spawn(&main);
        let linked_child = spawn(&linked);
        let main_output = main_child.wait_with_output().unwrap();
        let linked_output = linked_child.wait_with_output().unwrap();
        assert!(main_output.status.success());
        assert!(linked_output.status.success());
        (json(&main_output), json(&linked_output))
    };
    let (cold_main, cold_linked) = concurrent_pair();
    let (warm_main, warm_linked) = concurrent_pair();
    for (main_report, linked_report) in [(&cold_main, &cold_linked), (&warm_main, &warm_linked)] {
        assert_eq!(main_report["status"], "findings");
        assert_eq!(linked_report["status"], "clean");
        assert_eq!(
            main_report["documentationRequirements"][0]["code"],
            "sense.documentation.document_not_updated"
        );
        assert!(
            linked_report["documentationRequirements"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(main_report["documentationCoverage"]["changedDocuments"], 0);
        assert_eq!(
            linked_report["documentationCoverage"]["changedDocuments"],
            1
        );
        assert_ne!(main_report["validAsOf"], linked_report["validAsOf"]);
    }
    assert_eq!(warm_main["cache"]["misses"], 0);
    assert_eq!(warm_linked["cache"]["misses"], 0);
}

#[test]
fn staged_content_and_sparse_index_fallback_produce_exact_workspace_views() {
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

    fs::write(
        repo.join("src/b.ts"),
        "import './a';\nexport const b = 1;\n",
    )
    .unwrap();
    git(&repo, &["add", "src/b.ts"]);
    let staged_cycle = sense(&repo, &cache, false);
    assert!(!staged_cycle.status.success());
    assert_eq!(json(&staged_cycle)["status"], "findings");

    fs::write(
        repo.join("src/b.ts"),
        "import type { a } from './a';\nexport const b = 1;\n",
    )
    .unwrap();
    let dirty_after_staged = sense(&repo, &cache, false);
    assert!(dirty_after_staged.status.success());
    assert_eq!(json(&dirty_after_staged)["status"], "clean");
    assert_eq!(json(&dirty_after_staged)["after"]["typeOnlyEdges"], 1);

    git(&repo, &["reset", "--hard", "-q", "HEAD"]);
    git(&repo, &["update-index", "--skip-worktree", "src/b.ts"]);
    fs::remove_file(repo.join("src/b.ts")).unwrap();
    let sparse = sense(&repo, &cache, false);
    assert!(sparse.status.success());
    assert_eq!(json(&sparse)["status"], "clean");
    assert_eq!(json(&sparse)["after"]["files"], 2);
    assert_eq!(json(&sparse)["after"]["runtimeEdges"], 1);
}

#[test]
fn node_reexports_block_cycles_while_dynamic_imports_degrade_without_an_edge() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(
        &repo,
        &[
            ("src/a.ts", "export { b } from './b';\n"),
            ("src/b.ts", "export const b = 1;\n"),
        ],
    );

    fs::write(repo.join("src/b.ts"), "export { a } from './a';\n").unwrap();
    let cycle = sense(&repo, &cache, false);
    assert!(!cycle.status.success());
    assert_eq!(json(&cycle)["status"], "findings");

    git(&repo, &["reset", "--hard", "-q", "HEAD"]);
    fs::write(
        repo.join("src/a.ts"),
        "export async function load() { return import('./b'); }\n",
    )
    .unwrap();
    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "partial");
    assert_eq!(
        report["after"]["coverage"]["unsupportedDynamicReferences"],
        1
    );
    assert_eq!(report["after"]["runtimeEdges"], 0);
    assert!(sense_allow_partial(&repo, &cache).status.success());
}

#[test]
fn python_sibling_import_cycles_and_new_target_ambiguity_are_exact() {
    let (_temp, repo, cache) = repository_paths();
    initialize(
        &repo,
        &[("pkg/a.py", "import b\na = 1\n"), ("pkg/b.py", "b = 1\n")],
    );

    fs::write(repo.join("pkg/b.py"), "from . import a\nb = 1\n").unwrap();
    let cycle = sense(&repo, &cache, false);
    assert!(!cycle.status.success());
    assert_eq!(json(&cycle)["introducedCycles"][0]["memberCount"], 2);

    git(&repo, &["reset", "--hard", "-q", "HEAD"]);
    fs::create_dir_all(repo.join("pkg/b")).unwrap();
    fs::write(repo.join("pkg/b/__init__.py"), "b = 2\n").unwrap();
    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "partial");
    assert_eq!(report["after"]["runtimeEdges"], 0);
    assert_eq!(report["after"]["coverage"]["ambiguousReferences"], 1);
}

#[test]
fn high_fan_in_is_a_confirmed_bounded_agent_observation() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(&repo, &[("src/core.ts", "export const core = 1;\n")]);
    for index in 0..11 {
        fs::write(
            repo.join(format!("src/importer-{index}.ts")),
            "import './core';\nexport const importer = true;\n",
        )
        .unwrap();
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "add dependents"]);

    fs::write(
        repo.join("src/core.ts"),
        "// changed\nexport const core = 1;\n",
    )
    .unwrap();
    let output = sense(&repo, &cache, false);
    assert!(output.status.success());
    let report = json(&output);
    assert_eq!(
        report["observations"]["highImpactChanges"][0]["path"],
        "src/core.ts"
    );
    assert_eq!(
        report["observations"]["highImpactChanges"][0]["confirmedDirectDependents"],
        11
    );
    assert_eq!(
        report["observations"]["impact"][0]["confirmedReachableDependents"],
        11
    );
    let important = &report["observations"]["importantNodes"][0];
    assert_eq!(important["path"], "src/core.ts");
    assert_eq!(important["beforeConfirmedDependencyFanIn"], 11);
    assert_eq!(important["afterConfirmedDependencyFanIn"], 11);
    assert_eq!(important["newlyImportant"], false);
    assert_eq!(important["publicSurfaceChanged"], false);
    assert_eq!(report["documentationCoverage"]["evaluated"], false);
}

#[test]
fn documentation_ownership_is_lazy_exact_and_introduced_only() {
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
    fs::write(
        repo.join("src/importer-9.ts"),
        "import './core';\nexport const importer = true;\n",
    )
    .unwrap();
    fs::write(
        repo.join("src/core.ts"),
        "// changed\nexport const core = 1;\n",
    )
    .unwrap();
    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "findings");
    assert_eq!(
        report["documentationRequirements"][0]["code"],
        "sense.documentation.missing_binding"
    );
    assert_eq!(report["documentationCoverage"]["evaluated"], true);
    assert_eq!(report["documentationCoverage"]["afterRegistry"], "missing");
    fs::write(repo.join(".opcore.json"), "{ malformed").unwrap();
    let malformed = sense(&repo, &cache, true);
    assert!(!malformed.status.success());
    let report = json(&malformed);
    assert_eq!(report["status"], "incomplete");
    assert_eq!(
        report["issues"].as_array().unwrap().last().unwrap()["code"],
        "policy_invalid"
    );
    fs::write(
        repo.join(".opcore.json"),
        r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/core.ts","document":"src/core.ts"}]}}"#,
    )
    .unwrap();
    let self_bound = sense(&repo, &cache, true);
    assert!(!self_bound.status.success());
    let report = json(&self_bound);
    assert_eq!(report["status"], "incomplete");

    fs::create_dir_all(repo.join("docs")).unwrap();
    fs::write(repo.join("docs/core.md"), "Core module ownership.\n").unwrap();
    fs::write(
        repo.join(".opcore.json"),
        r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/core.ts","document":"docs/core.md"}]}}"#,
    )
    .unwrap();
    let documented = sense(&repo, &cache, false);
    assert!(documented.status.success());
    let report = json(&documented);
    assert_eq!(report["status"], "clean");
    assert!(
        report["documentationRequirements"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(report["documentationCoverage"]["documentsRequested"], 1);
    assert_eq!(report["documentationCoverage"]["afterDocuments"], 1);
    assert_eq!(report["documentationCoverage"]["changedDocuments"], 1);

    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "important documented module"]);
    fs::write(repo.join("src/core.ts"), "export const renamed = 1;\n").unwrap();
    let stale = sense(&repo, &cache, false);
    assert!(!stale.status.success());
    assert_eq!(
        json(&stale)["documentationRequirements"][0]["code"],
        "sense.documentation.document_not_updated"
    );

    fs::write(
        repo.join("docs/core.md"),
        "Core module ownership and renamed export.\n",
    )
    .unwrap();
    let updated = sense(&repo, &cache, false);
    assert!(updated.status.success());
    let report = json(&updated);
    assert_eq!(report["status"], "clean");
    assert_eq!(report["documentationCoverage"]["changedDocuments"], 1);
    assert!(report["validAsOf"].as_str().unwrap().contains("git-sense"));
}

#[test]
fn documentation_tracks_shape_changes_and_importance_threshold_exit() {
    let temp = tempfile::tempdir().unwrap();
    let shape_repo = temp.path().join("shape-repo");
    let shape_cache = temp.path().join("shape-cache");
    initialize(
        &shape_repo,
        &[
            ("src/core.ts", "export interface Core { first: string; }\n"),
            (
                ".opcore.json",
                r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/core.ts","document":"docs/core.md"}]}}"#,
            ),
            ("docs/core.md", "Core interface.\n"),
        ],
    );
    for index in 0..10 {
        fs::write(
            shape_repo.join(format!("src/importer-{index}.ts")),
            "import { Core } from './core';\nexport const importer = true;\n",
        )
        .unwrap();
    }
    git(&shape_repo, &["add", "."]);
    git(&shape_repo, &["commit", "-qm", "important shape"]);
    fs::write(
        shape_repo.join("src/core.ts"),
        "export interface Core { renamed: boolean; }\n",
    )
    .unwrap();

    let shape_result = sense(&shape_repo, &shape_cache, false);
    assert!(!shape_result.status.success());
    let shape_report = json(&shape_result);
    assert_eq!(
        shape_report["documentationRequirements"][0]["code"],
        "sense.documentation.document_not_updated"
    );
    assert_eq!(
        shape_report["observations"]["importantNodes"][0]["publicSurfaceChanged"],
        true
    );
    let interface = &shape_report["observations"]["interfaces"][0];
    assert_eq!(interface["beforePublicSurfaceAuthoritative"], true);
    assert_eq!(interface["afterPublicSurfaceAuthoritative"], true);
    assert_eq!(interface["publicSurfaceChanged"], true);
    assert_eq!(interface["beforeExports"], interface["afterExports"]);
    assert_eq!(
        interface["beforeMaxShapeMembers"],
        interface["afterMaxShapeMembers"]
    );

    let export_repo = temp.path().join("export-repo");
    let export_cache = temp.path().join("export-cache");
    let exports = |count: usize| {
        (0..count).fold(String::new(), |mut source, index| {
            writeln!(source, "export const value_{index:02} = {index};").unwrap();
            source
        })
    };
    initialize(
        &export_repo,
        &[
            ("src/core.ts", &exports(21)),
            (
                ".opcore.json",
                r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/core.ts","document":"docs/core.md"}]}}"#,
            ),
            ("docs/core.md", "Core exports.\n"),
        ],
    );
    fs::write(export_repo.join("src/core.ts"), exports(20)).unwrap();

    let threshold_result = sense(&export_repo, &export_cache, false);
    assert!(!threshold_result.status.success());
    let threshold_report = json(&threshold_result);
    assert_eq!(
        threshold_report["documentationRequirements"][0]["code"],
        "sense.documentation.document_not_updated"
    );
    assert_eq!(
        threshold_report["observations"]["importantNodes"][0]["beforeExplicitExports"],
        21
    );
    assert_eq!(
        threshold_report["observations"]["importantNodes"][0]["afterExplicitExports"],
        20
    );
}

#[test]
fn unknown_baseline_surface_does_not_fabricate_new_importance() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    let exports = (0..21).fold(String::new(), |mut source, index| {
        writeln!(source, "export const value_{index:02} = {index};").unwrap();
        source
    });
    initialize(
        &repo,
        &[
            ("src/api.ts", "export * from './values';\n"),
            ("src/values.ts", &exports),
        ],
    );
    let names = (0..21)
        .map(|index| format!("value_{index:02}"))
        .collect::<Vec<_>>()
        .join(", ");
    fs::write(
        repo.join("src/api.ts"),
        format!("export {{ {names} }} from './values';\n"),
    )
    .unwrap();

    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "partial");
    assert!(report["interfaceFindings"].as_array().unwrap().is_empty());
    assert!(
        report["documentationRequirements"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(report["documentationCoverage"]["evaluated"], false);
    assert_eq!(
        report["observations"]["importantNodes"][0]["newlyImportant"],
        false
    );
}

#[test]
fn fan_in_transition_does_not_require_docs_for_an_unmodified_target() {
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
    fs::write(
        repo.join("src/importer-9.ts"),
        "import './core';\nexport const importer = true;\n",
    )
    .unwrap();

    let output = sense(&repo, &cache, false);
    assert!(output.status.success());
    let report = json(&output);
    assert_eq!(report["status"], "clean");
    assert_eq!(report["documentationCoverage"]["evaluated"], false);
    assert!(
        report["observations"]["importantNodes"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn documentation_rebinding_reads_only_the_new_owner_document() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    let oversized_old = "x".repeat(opcore::api::test_support::MAX_SOURCE_BYTES + 1);
    initialize(
        &repo,
        &[
            ("src/core.ts", "export const core = 1;\n"),
            (
                ".opcore.json",
                r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/core.ts","document":"docs/old.md"}]}}"#,
            ),
            ("docs/old.md", &oversized_old),
            ("docs/new.md", "New core ownership.\n"),
        ],
    );
    for index in 0..10 {
        fs::write(
            repo.join(format!("src/importer-{index}.ts")),
            "import './core';\nexport const importer = true;\n",
        )
        .unwrap();
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "important module"]);
    fs::write(repo.join("src/core.ts"), "export const renamed = 1;\n").unwrap();
    fs::write(
        repo.join(".opcore.json"),
        r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/core.ts","document":"docs/new.md"}]}}"#,
    )
    .unwrap();

    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "findings");
    assert_eq!(report["documentationCoverage"]["documentsRequested"], 1);
    assert_eq!(
        report["documentationRequirements"][0]["code"],
        "sense.documentation.document_not_updated"
    );

    fs::write(repo.join("docs/new.md"), "Updated core ownership.\n").unwrap();
    let updated = sense(&repo, &cache, false);
    assert!(updated.status.success());
    let report = json(&updated);
    assert_eq!(report["status"], "clean");
    assert_eq!(report["documentationCoverage"]["documentsRequested"], 1);
    assert!(
        report["documentationRequirements"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    fs::write(
        repo.join(".opcore.json"),
        r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/core.ts","document":"docs/old.md"}]}}"#,
    )
    .unwrap();
    let required_oversized = sense(&repo, &cache, true);
    assert!(!required_oversized.status.success());
    let report = json(&required_oversized);
    assert_eq!(report["status"], "incomplete");
    assert_eq!(report["documentationCoverage"]["documentsRequested"], 1);
    assert_eq!(
        report["issues"].as_array().unwrap().last().unwrap()["code"],
        "documentation_files_capture_failed"
    );
}

#[test]
fn important_rename_and_deletion_require_exact_registry_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(
        &repo,
        &[
            ("src/core.ts", "export const core = 1;\n"),
            (
                ".opcore.json",
                r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/core.ts","document":"docs/core.md"}]}}"#,
            ),
            ("docs/core.md", "Core module ownership.\n"),
        ],
    );
    for index in 0..10 {
        fs::write(
            repo.join(format!("src/importer-{index}.ts")),
            "import './core';\nexport const importer = true;\n",
        )
        .unwrap();
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "important module"]);

    git(&repo, &["mv", "src/core.ts", "src/renamed.ts"]);
    for index in 0..10 {
        fs::write(
            repo.join(format!("src/importer-{index}.ts")),
            "import './renamed';\nexport const importer = true;\n",
        )
        .unwrap();
    }
    let stale_rename = sense(&repo, &cache, true);
    assert!(stale_rename.status.success());
    let stale_report = json(&stale_rename);
    let stale_binding = stale_report["documentationRequirements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|finding| finding["code"] == "sense.documentation.stale_binding")
        .unwrap();
    assert_eq!(stale_binding["path"], "src/renamed.ts");
    assert_eq!(stale_binding["beforePath"], "src/core.ts");
    fs::write(
        repo.join(".opcore.json"),
        r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/renamed.ts","document":"docs/core.md"}]}}"#,
    )
    .unwrap();
    let renamed = sense(&repo, &cache, false);
    assert!(renamed.status.success());
    let report = json(&renamed);
    assert_eq!(report["status"], "clean");
    let important = report["observations"]["importantNodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["path"] == "src/renamed.ts")
        .unwrap();
    assert_eq!(important["beforePath"], "src/core.ts");
    assert!(
        report["documentationRequirements"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(report["documentationCoverage"]["changedDocuments"], 0);

    git(&repo, &["reset", "--hard", "-q", "HEAD"]);
    git(&repo, &["rm", "-q", "src/core.ts"]);
    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "partial");
    assert!(
        report["documentationRequirements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|finding| finding["code"] == "sense.documentation.stale_binding")
    );

    fs::write(
        repo.join(".opcore.json"),
        r#"{"schemaVersion":1,"documentation":{"bindings":[]}}"#,
    )
    .unwrap();
    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "partial");
    assert!(
        report["documentationRequirements"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn introduced_module_surface_blocks_with_effective_policy_and_coverage() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    let exports = |count: usize| {
        (0..count).fold(String::new(), |mut source, index| {
            writeln!(source, "export const value_{index:02} = {index};").unwrap();
            source
        })
    };
    initialize(&repo, &[("src/api.ts", &exports(20))]);

    fs::write(repo.join("src/api.ts"), exports(21)).unwrap();
    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "findings");
    assert_eq!(report["interfaceFindings"].as_array().unwrap().len(), 1);
    assert_eq!(
        report["interfaceFindings"][0]["code"],
        "sense.interface.module_exports"
    );
    assert_eq!(report["interfaceFindings"][0]["before"], 20);
    assert_eq!(report["interfaceFindings"][0]["after"], 21);
    assert_eq!(report["interfaceFindings"][0]["basis"], "confirmed");
    assert_eq!(report["effectivePolicy"]["maxModuleExports"], 20);
    assert_eq!(report["effectivePolicy"]["minimumCallableTokens"], 48);
    assert_eq!(report["after"]["interfaceCoverage"]["completeFiles"], 1);
    assert_eq!(
        report["after"]["interfaceCoverage"]["completePublicSurfaces"],
        1
    );
    assert!(sense(&repo, &cache, true).status.success());

    git(&repo, &["add", "src/api.ts"]);
    git(&repo, &["commit", "-qm", "accept broad surface"]);
    let baseline_debt = sense(&repo, &cache, false);
    assert!(baseline_debt.status.success());
    assert_eq!(json(&baseline_debt)["status"], "clean");
}

#[test]
fn confirmed_module_export_lower_bound_blocks_under_partial_surface_coverage() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    let exports = |count: usize| {
        (0..count).fold(String::new(), |mut source, index| {
            writeln!(source, "export const value_{index:02} = {index};").unwrap();
            source
        })
    };
    initialize(
        &repo,
        &[
            ("src/api.ts", &exports(20)),
            ("src/more.ts", "export const more = 1;\n"),
        ],
    );

    fs::write(
        repo.join("src/api.ts"),
        format!("{}export * from './more';\n", exports(21)),
    )
    .unwrap();
    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "partial");
    assert_eq!(
        report["after"]["interfaceCoverage"]["partialPublicSurfaces"],
        1
    );
    assert_eq!(
        report["interfaceFindings"][0]["code"],
        "sense.interface.module_exports"
    );
    assert_eq!(report["interfaceFindings"][0]["before"], 20);
    assert_eq!(report["interfaceFindings"][0]["after"], 21);
}

#[test]
fn python_without_static_all_keeps_dependency_sense_partial_and_surface_coverage_honest() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    initialize(
        &repo,
        &[
            ("pkg/a.py", "from .b import value\n"),
            ("pkg/b.py", "value = 1\n"),
        ],
    );
    fs::write(repo.join("pkg/b.py"), "# changed\nvalue = 1\n").unwrap();

    let report = blocking_sense(&repo, &cache);
    assert_eq!(report["status"], "partial");
    assert_eq!(report["after"]["interfaceCoverage"]["completeFiles"], 1);
    assert_eq!(
        report["after"]["interfaceCoverage"]["unsupportedPublicSurfaces"],
        1
    );
    assert_eq!(report["after"]["interfaceCoverage"]["unsupportedFiles"], 0);
}

#[test]
fn unborn_head_and_parser_failure_never_fabricate_a_clean_graph() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cache = temp.path().join("cache");
    fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q"]);
    fs::write(repo.join("src/a.ts"), "import './b';\n").unwrap();
    fs::write(repo.join("src/b.ts"), "import './a';\n").unwrap();

    let unborn = sense(&repo, &cache, false);
    assert!(!unborn.status.success());
    assert_eq!(json(&unborn)["status"], "findings");

    git(&repo, &["config", "user.name", "Test"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "cycle baseline"]);
    fs::write(repo.join("src/b.ts"), "import './a';\nfunction {\n").unwrap();
    let parser_failure = sense(&repo, &cache, false);
    assert!(!parser_failure.status.success());
    assert_eq!(json(&parser_failure)["status"], "partial");
    assert_eq!(
        json(&parser_failure)["after"]["coverage"]["parserFailedFiles"],
        1
    );
}

#[test]
fn unsupported_dependency_forms_and_languages_never_report_clean() {
    let temp = tempfile::tempdir().unwrap();
    let cjs = temp.path().join("cjs");
    let python = temp.path().join("python");
    let hcl = temp.path().join("hcl");
    let shell = temp.path().join("shell");
    let protobuf = temp.path().join("protobuf");
    let docs = temp.path().join("docs");

    initialize(
        &cjs,
        &[
            ("a.cjs", "require('./b');\n"),
            ("b.cjs", "require('./a');\n"),
        ],
    );
    let cjs_report = json(&sense(&cjs, &temp.path().join("cjs-cache"), false));
    assert_eq!(cjs_report["status"], "partial");
    assert_eq!(
        cjs_report["after"]["coverage"]["unsupportedDynamicReferences"],
        2
    );

    initialize(
        &python,
        &[
            ("a.py", "import missing.module\n"),
            ("b.py", "import absent.package\n"),
        ],
    );
    let python_report = json(&sense(&python, &temp.path().join("python-cache"), false));
    assert_eq!(python_report["status"], "partial");
    assert_eq!(python_report["after"]["coverage"]["ambiguousReferences"], 2);
    assert_eq!(
        python_report["after"]["coverage"]["unresolvedReferences"],
        0
    );
    assert_eq!(python_report["after"]["coverage"]["externalReferences"], 0);

    initialize(&hcl, &[("main.tf", "locals { value = \"before\" }\n")]);
    fs::write(hcl.join("main.tf"), "locals { value = \"after\" }\n").unwrap();
    let hcl_report = json(&sense(&hcl, &temp.path().join("hcl-cache"), false));
    assert_eq!(hcl_report["status"], "partial");
    assert_eq!(hcl_report["changedFiles"], 1);
    assert_eq!(hcl_report["after"]["files"], 1);
    assert_eq!(hcl_report["after"]["coverage"]["unsupportedFiles"], 1);

    initialize(&shell, &[("main.sh", "#!/bin/sh\necho before\n")]);
    fs::write(shell.join("main.sh"), "#!/bin/sh\n. ./other.sh\n").unwrap();
    let shell_report = json(&sense(&shell, &temp.path().join("shell-cache"), false));
    assert_eq!(shell_report["status"], "partial");
    assert_eq!(shell_report["changedFiles"], 1);
    assert_eq!(shell_report["after"]["coverage"]["unsupportedFiles"], 1);

    initialize(
        &protobuf,
        &[(
            "schema.proto",
            "syntax = \"proto3\"; message A { string before = 1; }\n",
        )],
    );
    fs::write(
        protobuf.join("schema.proto"),
        "syntax = \"proto3\"; message A { string after = 1; }\n",
    )
    .unwrap();
    let protobuf_report = json(&sense(
        &protobuf,
        &temp.path().join("protobuf-cache"),
        false,
    ));
    assert_eq!(protobuf_report["status"], "partial");
    assert_eq!(protobuf_report["after"]["coverage"]["unsupportedFiles"], 1);

    initialize(
        &docs,
        &[
            ("main.ts", "export const value = 1;\n"),
            ("README.md", "before\n"),
        ],
    );
    fs::write(docs.join("README.md"), "after\n").unwrap();
    let docs_report = json(&sense(&docs, &temp.path().join("docs-cache"), false));
    assert_eq!(docs_report["status"], "clean");
    assert_eq!(docs_report["changedFiles"], 0);
    assert_eq!(docs_report["after"]["files"], 1);
}

use super::*;
use std::fs;
use std::process::Command;
use tempfile::TempDir;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn detects_cross_file_duplicate_blocks_with_stable_line_free_identity() -> TestResult {
    let fixture = clone_fixture()?;
    write_source(
        fixture.path(),
        "src/a.ts",
        "export function a() {\n  const one = 1;\n  const two = 2;\n  const three = 3;\n  const four = one + two;\n  return four + three;\n}\n",
    )?;
    write_source(
        fixture.path(),
        "src/b.ts",
        "\n\nexport function b() {\n  const one = 1;\n  const two = 2;\n  const three = 3;\n  const four = one + two;\n  return four + three;\n}\n",
    )?;
    init_git_snapshot(fixture.path(), &["src/a.ts", "src/b.ts"])?;

    let result = analyze_clones(request(fixture.path(), CloneReportMode::All, Vec::new())?)?;

    let finding = result
        .findings
        .iter()
        .find(|finding| finding.path == "src/a.ts" && finding.peer_path == "src/b.ts")
        .ok_or_else(|| std::io::Error::other("missing a.ts duplicate finding"))?;
    assert_eq!(finding.clone_class_id.len(), "clone-0123456789abcdef".len());
    assert_eq!(
        finding.paths,
        vec!["src/a.ts".to_string(), "src/b.ts".to_string()]
    );
    assert!(result.db_path.is_some());
    assert!(fixture.path().join(".opcore/clone/clone.db").exists());
    Ok(())
}

#[test]
fn no_overlay_non_git_repo_does_not_write_persistent_db() -> TestResult {
    let fixture = clone_fixture()?;
    let duplicate = duplicate_block();
    write_source(fixture.path(), "src/a.ts", &duplicate)?;
    write_source(fixture.path(), "src/b.ts", &duplicate)?;

    let result = analyze_clones(request(fixture.path(), CloneReportMode::All, Vec::new())?)?;

    assert!(!result.findings.is_empty());
    assert!(!result.persisted);
    assert!(result.db_path.is_none());
    assert!(!fixture.path().join(".opcore/clone/clone.db").exists());
    Ok(())
}

#[test]
fn introduced_mode_reports_overlay_clones_without_writing_persistent_db() -> TestResult {
    let fixture = clone_fixture()?;
    write_source(
        fixture.path(),
        "src/existing.ts",
        "export function existing() {\n  const one = 1;\n  const two = 2;\n  const three = 3;\n  const four = one + two;\n  return four + three;\n}\n",
    )?;
    let overlay_content = "export function created() {\n  const one = 1;\n  const two = 2;\n  const three = 3;\n  const four = one + two;\n  return four + three;\n}\n";
    let overlays = vec![CloneOverlay::Write {
        path: "src/new.ts".to_string(),
        content: overlay_content.to_string(),
        checksum_before: None,
    }];

    let result = analyze_clones(request(
        fixture.path(),
        CloneReportMode::Introduced,
        overlays,
    )?)?;

    assert!(!result.persisted);
    assert!(result.db_path.is_none());
    assert!(!fixture.path().join(".opcore/clone/clone.db").exists());
    assert!(result.findings.iter().any(|finding| {
        finding.path == "src/new.ts" && finding.peer_path == "src/existing.ts" && finding.introduced
    }));
    Ok(())
}

#[test]
fn introduced_mode_suppresses_preexisting_clone_classes() -> TestResult {
    let fixture = clone_fixture()?;
    let duplicate = "export function duplicate() {\n  const one = 1;\n  const two = 2;\n  const three = 3;\n  const four = one + two;\n  return four + three;\n}\n";
    write_source(fixture.path(), "src/a.ts", duplicate)?;
    write_source(fixture.path(), "src/b.ts", duplicate)?;

    let result = analyze_clones(request(
        fixture.path(),
        CloneReportMode::Introduced,
        Vec::new(),
    )?)?;

    assert!(result.findings.is_empty());
    Ok(())
}

#[test]
fn no_overlay_dirty_git_sources_do_not_write_persistent_db() -> TestResult {
    let fixture = clone_fixture()?;
    let duplicate = duplicate_block();
    write_source(fixture.path(), "src/a.ts", &duplicate)?;
    write_source(fixture.path(), "src/b.ts", &duplicate)?;
    init_git_snapshot(fixture.path(), &["src/a.ts", "src/b.ts"])?;
    write_source(fixture.path(), "src/a.ts", "export const dirty = 1;\n")?;
    write_source(fixture.path(), "src/untracked.ts", &duplicate)?;

    let result = analyze_clones(request(fixture.path(), CloneReportMode::All, Vec::new())?)?;

    assert!(!result.persisted);
    assert!(result.db_path.is_none());
    assert!(!fixture.path().join(".opcore/clone/clone.db").exists());
    Ok(())
}

#[test]
fn no_overlay_deleted_tracked_source_does_not_write_persistent_db() -> TestResult {
    let fixture = clone_fixture()?;
    let duplicate = duplicate_block();
    write_source(fixture.path(), "src/a.ts", &duplicate)?;
    write_source(fixture.path(), "src/b.ts", &duplicate)?;
    init_git_snapshot(fixture.path(), &["src/a.ts", "src/b.ts"])?;
    fs::remove_file(fixture.path().join("src/b.ts"))?;

    let result = analyze_clones(request(fixture.path(), CloneReportMode::All, Vec::new())?)?;

    assert!(!result.persisted);
    assert!(result.db_path.is_none());
    assert!(!fixture.path().join(".opcore/clone/clone.db").exists());
    Ok(())
}

#[test]
fn scoped_no_overlay_requests_are_ephemeral() -> TestResult {
    let fixture = clone_fixture()?;
    let duplicate = duplicate_block();
    write_source(fixture.path(), "src/a.ts", &duplicate)?;
    write_source(fixture.path(), "src/b.ts", &duplicate)?;
    let mut clone_request = request(fixture.path(), CloneReportMode::All, Vec::new())?;
    clone_request.paths = vec!["src/a.ts".to_string()];

    let result = analyze_clones(clone_request)?;

    assert!(!result.persisted);
    assert!(result.db_path.is_none());
    assert!(!fixture.path().join(".opcore/clone/clone.db").exists());
    assert!(result
        .findings
        .iter()
        .any(|finding| finding.path == "src/a.ts"));
    Ok(())
}

#[test]
fn sparse_path_list_request_reports_committed_peer_and_applies_write_delete_overlays() -> TestResult
{
    let fixture = clone_fixture()?;
    let duplicate = duplicate_block();
    write_source(fixture.path(), "src/peer.ts", &duplicate)?;
    write_source(fixture.path(), "src/deleted.ts", &duplicate)?;
    init_git_snapshot(fixture.path(), &["src/peer.ts", "src/deleted.ts"])?;

    let mut clone_request = request(
        fixture.path(),
        CloneReportMode::Introduced,
        vec![
            CloneOverlay::Write {
                path: "src/new.ts".to_string(),
                content: duplicate,
                checksum_before: None,
            },
            CloneOverlay::Delete {
                path: "src/deleted.ts".to_string(),
                checksum_before: None,
            },
        ],
    )?;
    clone_request.paths = vec!["src/new.ts".to_string(), "src/deleted.ts".to_string()];
    clone_request.source_paths = Some(vec![
        "src/peer.ts".to_string(),
        "src/deleted.ts".to_string(),
        "src/new.ts".to_string(),
    ]);

    let result = analyze_clones(clone_request)?;

    assert!(!result.persisted);
    assert!(result.db_path.is_none());
    assert!(result.findings.iter().any(|finding| {
        finding.path == "src/new.ts" && finding.peer_path == "src/peer.ts" && finding.introduced
    }));
    assert!(result
        .findings
        .iter()
        .all(|finding| finding.path != "src/deleted.ts" && finding.peer_path != "src/deleted.ts"));
    Ok(())
}

#[test]
fn clone_exclude_patterns_remove_sources_from_analysis() -> TestResult {
    let fixture = clone_fixture()?;
    let duplicate = duplicate_block();
    write_source(fixture.path(), "src/a.ts", &duplicate)?;
    write_source(fixture.path(), "src/b.ts", &duplicate)?;
    let mut clone_request = request(fixture.path(), CloneReportMode::All, Vec::new())?;
    clone_request.exclude = vec!["src/b.ts".to_string()];

    let result = analyze_clones(clone_request)?;

    assert!(result.findings.is_empty());
    Ok(())
}

#[test]
fn clone_partitions_only_compare_paths_inside_same_group() -> TestResult {
    let fixture = clone_fixture()?;
    let duplicate = duplicate_block();
    write_source(fixture.path(), "server/a.ts", &duplicate)?;
    write_source(fixture.path(), "server/b.ts", &duplicate)?;
    write_source(fixture.path(), "client/c.ts", &duplicate)?;
    let mut clone_request = request(fixture.path(), CloneReportMode::All, Vec::new())?;
    clone_request.partitions = vec![vec!["server".to_string()], vec!["client".to_string()]];

    let result = analyze_clones(clone_request)?;

    assert!(result
        .findings
        .iter()
        .any(|finding| finding.path == "server/a.ts" && finding.peer_path == "server/b.ts"));
    assert!(result
        .findings
        .iter()
        .all(|finding| !finding.path.starts_with("client/")
            && !finding.peer_path.starts_with("client/")));
    Ok(())
}

#[test]
fn clone_window_min_lines_and_threshold_suppress_short_or_small_blocks() -> TestResult {
    let fixture = clone_fixture()?;
    let duplicate = duplicate_block();
    write_source(fixture.path(), "src/a.ts", &duplicate)?;
    write_source(fixture.path(), "src/b.ts", &duplicate)?;

    let mut short_window_request = request(fixture.path(), CloneReportMode::All, Vec::new())?;
    short_window_request.window_size = Some(4);
    short_window_request.min_lines = Some(6);
    assert!(analyze_clones(short_window_request)?.findings.is_empty());

    let mut high_threshold_request = request(fixture.path(), CloneReportMode::All, Vec::new())?;
    high_threshold_request.min_tokens = None;
    high_threshold_request.threshold = Some(999);
    assert!(analyze_clones(high_threshold_request)?.findings.is_empty());
    Ok(())
}

fn clone_fixture() -> Result<TempDir, std::io::Error> {
    let fixture = TempDir::new()?;
    fs::create_dir_all(fixture.path().join("src"))?;
    Ok(fixture)
}

fn duplicate_block() -> String {
    [
        "export function duplicated() {",
        "  const one = 1;",
        "  const two = 2;",
        "  const three = 3;",
        "  const four = one + two;",
        "  return four + three;",
        "}",
        "",
    ]
    .join("\n")
}

fn write_source(
    repo_root: &Path,
    relative_path: &str,
    content: &str,
) -> Result<(), std::io::Error> {
    let path = repo_root.join(relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)
}

fn request(
    repo_root: &Path,
    report_mode: CloneReportMode,
    overlays: Vec<CloneOverlay>,
) -> Result<CloneAnalysisRequest, std::io::Error> {
    Ok(CloneAnalysisRequest {
        protocol: CLONE_PROTOCOL.to_string(),
        request_id: Some("clone-test".to_string()),
        schema_version: CLONE_SCHEMA_VERSION,
        repo: RepoIdentity {
            repo_id: None,
            repo_root: Some(repo_root.canonicalize()?.to_string_lossy().to_string()),
            remote_url: None,
            commit_sha: None,
        },
        report_mode,
        paths: Vec::new(),
        source_paths: None,
        source_read_mode: None,
        source_tree_ref: None,
        overlays,
        window_size: None,
        min_lines: Some(5),
        min_tokens: Some(12),
        threshold: None,
        partitions: Vec::new(),
        exclude: Vec::new(),
        modes: Vec::new(),
    })
}

fn init_git_snapshot(repo_root: &Path, files: &[&str]) -> Result<(), Box<dyn std::error::Error>> {
    git(repo_root, &["init", "-q"])?;
    git(repo_root, &["symbolic-ref", "HEAD", "refs/heads/main"])?;
    git(repo_root, &["add", "--"])?;
    for file in files {
        git(repo_root, &["add", file])?;
    }
    git_with_env(
        repo_root,
        &["commit", "-q", "-m", "initial"],
        &[
            ("GIT_AUTHOR_NAME", "Opcore"),
            ("GIT_AUTHOR_EMAIL", "opcore@example.invalid"),
            ("GIT_AUTHOR_DATE", "2026-06-28T00:00:00Z"),
            ("GIT_COMMITTER_NAME", "Opcore"),
            ("GIT_COMMITTER_EMAIL", "opcore@example.invalid"),
            ("GIT_COMMITTER_DATE", "2026-06-28T00:00:00Z"),
        ],
    )?;
    Ok(())
}

fn git(repo_root: &Path, args: &[&str]) -> Result<String, Box<dyn std::error::Error>> {
    git_with_env(repo_root, args, &[])
}

fn git_with_env(
    repo_root: &Path,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<String, Box<dyn std::error::Error>> {
    let mut command = Command::new("git");
    command.arg("-C").arg(repo_root).args(args);
    for (key, value) in env {
        command.env(key, value);
    }
    let output = command.output()?;
    if output.status.success() {
        return Ok(String::from_utf8(output.stdout)?);
    }
    Err(format!(
        "git {} failed: {}{}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    )
    .into())
}

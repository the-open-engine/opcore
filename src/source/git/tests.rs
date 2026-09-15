use super::*;

#[test]
fn git_process_output_is_actively_bounded() {
    let mut command = std::process::Command::new("sh");
    command.args(["-c", "printf 123456789"]);

    assert!(matches!(
        objects::bounded_command_output(&mut command, 8, 8),
        Err(SourceError::Incomplete(_))
    ));
}

fn initialize_repository(root: &Path) {
    fs::create_dir_all(root.join("src")).unwrap();
    git_at(root, ["init", "-q"]).unwrap();
    git_at(root, ["config", "user.name", "Test"]).unwrap();
    git_at(root, ["config", "user.email", "test@example.com"]).unwrap();
    fs::write(
        root.join("src/a.ts"),
        "export function ok(a) { return a; }\n",
    )
    .unwrap();
    git_at(root, ["add", "src/a.ts"]).unwrap();
    git_at(root, ["commit", "-qm", "initial"]).unwrap();
}

#[test]
fn captured_dirty_content_must_match_the_stability_sentinel() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("repo");
    initialize_repository(&root);
    let repository = GitRepository::discover(&root).unwrap();
    fs::write(
        root.join("src/a.ts"),
        "export function first(a) { return a; }\n",
    )
    .unwrap();
    let sentinel = repository
        .sentinel(GitScope::Changed, &[], None, None)
        .unwrap();
    fs::write(
        root.join("src/a.ts"),
        "export function changed(a,b,c,d,e,f) { return a; }\n",
    )
    .unwrap();
    let result = repository.capture_once(GitScope::Changed, &[], &sentinel);
    assert!(matches!(result, Err(SourceError::Changed(_))));
}

#[test]
fn generation_metadata_detects_same_content_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("repo");
    initialize_repository(&root);
    let repository = GitRepository::discover(&root).unwrap();
    let dirty = "export function dirty(a) { return a; }\n";
    fs::write(root.join("src/a.ts"), dirty).unwrap();
    let before = repository
        .sentinel(GitScope::Changed, &[], None, None)
        .unwrap();
    fs::write(root.join("src/replacement"), dirty).unwrap();
    fs::rename(root.join("src/replacement"), root.join("src/a.ts")).unwrap();
    let after = repository
        .sentinel(GitScope::Changed, &[], None, None)
        .unwrap();
    assert_eq!(before.worktree_state, after.worktree_state);
    assert_ne!(before.scope_state, after.scope_state);
}

#[test]
fn moving_refs_invalidate_tree_captures() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("repo");
    initialize_repository(&root);
    let repository = GitRepository::discover(&root).unwrap();
    git_at(&root, ["branch", "moving", "HEAD"]).unwrap();
    let capture = repository
        .capture_from(GitScope::Tree, &[], None, Some("moving"))
        .unwrap();

    fs::write(
        root.join("src/a.ts"),
        "export function next(a) { return a; }\n",
    )
    .unwrap();
    git_at(&root, ["add", "src/a.ts"]).unwrap();
    git_at(&root, ["commit", "-qm", "move ref target"]).unwrap();
    git_at(&root, ["branch", "-f", "moving", "HEAD"]).unwrap();

    assert!(
        !repository
            .is_current_from(&capture, GitScope::Tree, &[], None, Some("moving"))
            .unwrap()
    );
}

#[test]
fn malformed_porcelain_paths_are_rejected() {
    assert!(paths_from_porcelain_v1(b"?? ../escape.ts\0", &is_source_candidate).is_err());
    assert!(paths_from_porcelain_v1(b"bad\0", &is_source_candidate).is_err());
}

#[test]
fn porcelain_directory_records_are_not_source_paths() {
    let paths = paths_from_porcelain_v1(
        b"?? .claude/worktrees/embedded/\0?? src/new.ts\0",
        &is_source_candidate,
    )
    .unwrap();
    assert_eq!(
        paths,
        [RepoPath::from_protocol("src/new.ts").unwrap()]
            .into_iter()
            .collect()
    );
}

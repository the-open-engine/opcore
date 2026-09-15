use std::{collections::BTreeSet, fs};

use super::{GitRepository, GitScope, NativeCaptureFilter, NativeCaptureKind, git_at};
use crate::{
    limits::MAX_FILES,
    path::RepoPath,
    policy::{ConfigView, TargetPolicy},
};

fn path(value: &str) -> RepoPath {
    RepoPath::from_protocol(value).unwrap()
}

fn repository(root: &std::path::Path) -> GitRepository {
    git_at(root, ["init", "-q"]).unwrap();
    git_at(root, ["config", "user.name", "Selection test"]).unwrap();
    git_at(root, ["config", "user.email", "selection@example.invalid"]).unwrap();
    GitRepository::discover(root).unwrap()
}

#[test]
fn excluded_monorepo_subtree_is_filtered_before_source_count_and_content_bounds() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let repository = repository(root);
    fs::create_dir(root.join("generated")).unwrap();
    for index in 0..MAX_FILES {
        fs::write(
            root.join(format!("generated/{index}.ts")),
            "const = invalid",
        )
        .unwrap();
    }
    fs::write(
        root.join("generated/huge.ts"),
        vec![b'x'; crate::limits::MAX_SOURCE_BYTES + 1],
    )
    .unwrap();
    fs::write(root.join("app.ts"), "export const answer = 42;\n").unwrap();
    let selected = repository.with_targets(&TargetPolicy {
        exclude: vec![path("generated")],
    });
    let worktree = selected
        .capture_from(GitScope::All, &[], None, None)
        .unwrap();
    assert_eq!(worktree.paths, BTreeSet::from([path("app.ts")]));
    fs::write(root.join("generated/new.ts"), "still excluded").unwrap();
    assert!(
        selected
            .is_current_from(&worktree, GitScope::All, &[], None, None)
            .unwrap()
    );
    let sense = selected.capture_workspace().unwrap();
    assert_eq!(sense.after.files().count(), 1);
    assert!(
        repository
            .capture_from(GitScope::All, &[], None, None)
            .is_err()
    );
    git_at(root, ["add", "."]).unwrap();
    let staged = selected
        .capture_from(GitScope::StagedAll, &[], None, None)
        .unwrap();
    assert_eq!(staged.after.files().count(), 1);
    let staged_sense = selected.capture_staged_workspace().unwrap();
    assert_eq!(staged_sense.after.files().count(), 1);
    git_at(root, ["commit", "-qm", "monorepo"]).unwrap();
    let committed = selected.capture_tree_workspace("HEAD", None).unwrap();
    assert_eq!(committed.after.files().count(), 1);
    let fast = selected
        .capture_native_from(
            &ConfigView::Tree("HEAD".into()),
            None,
            &[],
            NativeCaptureFilter::empty().with(NativeCaptureKind::Fast),
        )
        .unwrap();
    assert_eq!(fast.paths.len(), 1);
}

#[test]
fn sense_retains_ancestor_go_module_metadata_and_immutable_docs_views() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let repository = repository(root);
    fs::create_dir_all(root.join("pkg")).unwrap();
    fs::write(root.join("go.mod"), "module example.com/project\n").unwrap();
    fs::write(
        root.join("pkg/api.go"),
        "package api\n\nfunc Answer() int { return 42 }\n",
    )
    .unwrap();
    fs::write(root.join("guide.md"), "original API").unwrap();
    git_at(root, ["add", "."]).unwrap();
    git_at(root, ["commit", "-qm", "base"]).unwrap();
    git_at(root, ["branch", "base"]).unwrap();
    fs::write(
        root.join("pkg/api.go"),
        "package api\n\nfunc Answer() int { return 43 }\n",
    )
    .unwrap();
    fs::write(root.join("guide.md"), "new API").unwrap();
    git_at(root, ["add", "."]).unwrap();
    git_at(root, ["commit", "-qm", "target"]).unwrap();
    fs::write(root.join("pkg/api.go"), "invalid dirty worktree").unwrap();
    fs::write(root.join("guide.md"), "dirty docs").unwrap();
    let selected = repository.with_targets(&TargetPolicy {
        exclude: vec![path("go.mod")],
    });
    let capture = selected
        .capture_tree_workspace("HEAD", Some("base"))
        .unwrap();
    assert!(capture.paths.contains(&path("go.mod")));
    assert_eq!(capture.changed_paths, BTreeSet::from([path("pkg/api.go")]));
    assert!(selected.is_workspace_current(&capture).unwrap());
    let docs = selected
        .capture_tree_auxiliary(&BTreeSet::from([path("guide.md")]), "HEAD", Some("base"))
        .unwrap();
    let document = &docs.paths[&path("guide.md")];
    assert_eq!(
        document.before.as_ref().unwrap().bytes.as_ref(),
        b"original API"
    );
    assert_eq!(document.after.as_ref().unwrap().bytes.as_ref(), b"new API");
}

#[test]
fn explicit_native_index_baseline_is_bound_and_revalidated() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let repository = repository(root);
    fs::write(root.join("app.ts"), "export const value = 1;\n").unwrap();
    git_at(root, ["add", "."]).unwrap();
    git_at(root, ["commit", "-qm", "base"]).unwrap();
    git_at(root, ["branch", "baseline"]).unwrap();
    fs::write(root.join("app.ts"), "export const value = 2;\n").unwrap();
    git_at(root, ["add", "."]).unwrap();
    git_at(root, ["commit", "-qm", "head"]).unwrap();
    let capture = repository
        .capture_native_from(
            &ConfigView::Index,
            Some("baseline"),
            &[],
            NativeCaptureFilter::empty().with(NativeCaptureKind::Fast),
        )
        .unwrap();
    assert_eq!(
        capture.paths[&path("app.ts")]
            .before
            .as_ref()
            .unwrap()
            .bytes
            .as_ref(),
        b"export const value = 1;\n"
    );
    assert_eq!(
        capture.paths[&path("app.ts")]
            .after
            .as_ref()
            .unwrap()
            .bytes
            .as_ref(),
        b"export const value = 2;\n"
    );
    fs::write(root.join("app.ts"), "dirty worktree").unwrap();
    assert!(repository.is_native_current(&capture).unwrap());
    git_at(root, ["branch", "-f", "baseline", "HEAD"]).unwrap();
    assert!(!repository.is_native_current(&capture).unwrap());
}

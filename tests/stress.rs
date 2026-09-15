use std::{collections::BTreeSet, sync::Arc};

use opcore::api::test_support::{
    AssessmentStatus, CancelToken, Comparison, Engine, EvaluationRequest, Language, RepoPath,
    RuleLimits, Scope, SourceFile, SourceSnapshot,
};

fn file(index: usize, changed: bool) -> SourceFile {
    let path =
        RepoPath::from_protocol(&format!("packages/p{}/src/file-{index}.ts", index % 25)).unwrap();
    let suffix = if changed { " + 1" } else { "" };
    SourceFile::new(
        path,
        format!("export function value_{index}(input) {{ return input{suffix}; }}\n").into_bytes(),
        Language::TypeScript,
        "typescript".into(),
    )
}

fn view(changed: usize) -> Arc<SourceSnapshot> {
    Arc::new(SourceSnapshot::new(
        (0..10_000).map(|index| file(index, index < changed)),
    ))
}

#[tokio::test]
#[ignore = "explicit large-project boundedness and profile evidence"]
async fn ten_thousand_file_repo_and_thousand_file_changeset_remain_bounded() {
    let before = view(0);
    let after = view(1_000);
    let changed_paths = (0..1_000)
        .map(|index| {
            RepoPath::from_protocol(&format!("packages/p{}/src/file-{index}.ts", index % 25))
                .unwrap()
        })
        .collect::<BTreeSet<_>>();
    let engine = Engine::new();
    let changed = engine
        .evaluate(
            EvaluationRequest {
                before: Some(Arc::clone(&before)),
                after: Arc::clone(&after),
                scope: Scope::Changeset,
                comparison: Comparison::Introduced,
                paths: changed_paths,
                limits: RuleLimits::default(),
                valid_as_of: "stress-changeset".into(),
                public_fingerprint_comparison: false,
            },
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(changed.status, AssessmentStatus::Clean);
    assert_eq!(changed.coverage.files_considered, 1_000);
    assert_eq!(changed.coverage.files_covered, 1_000);
    assert!(changed.coverage.gaps.is_empty());
    assert_eq!(changed.timing.files_read, 2_000);

    let workspace = engine
        .evaluate(
            EvaluationRequest {
                before: Some(before),
                after,
                scope: Scope::Workspace,
                comparison: Comparison::All,
                paths: BTreeSet::new(),
                limits: RuleLimits::default(),
                valid_as_of: "stress-workspace".into(),
                public_fingerprint_comparison: false,
            },
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(workspace.status, AssessmentStatus::Clean);
    assert_eq!(workspace.coverage.files_considered, 10_000);
    assert_eq!(workspace.coverage.files_covered, 10_000);
    assert!(workspace.coverage.gaps.is_empty());
    assert_eq!(workspace.timing.files_read, 10_000);
}

use super::*;
use crate::{
    path::{MAX_REPOSITORY_PATH_BYTES, RepoPath},
    sense::model::{DependencyEdge, EdgeKind, IntroducedCycle},
};

#[test]
fn final_json_bytes_are_bounded_after_timings_are_populated() {
    let mut report = incomplete_report("test", "test".into(), Instant::now());
    report.status = SenseStatus::Findings;
    report.issues.clear();
    let path = RepoPath::new(vec![0xff; MAX_REPOSITORY_PATH_BYTES]).unwrap();
    for _ in 0..32 {
        report.introduced_cycles.push(IntroducedCycle {
            member_count: 10,
            members: vec![path.clone(); 10],
            members_truncated: false,
            trigger: DependencyEdge {
                from: path.clone(),
                to: path.clone(),
                kind: EdgeKind::Runtime,
            },
            witness: vec![path.clone(); 10],
            witness_truncated: false,
        });
    }

    let started = Instant::now();
    let rendered = prepare_output(&mut report, true, started).unwrap();
    assert_eq!(report.status, SenseStatus::Incomplete);
    assert!(rendered.len() <= MAX_ASSESSMENT_BYTES);
    let emitted: serde_json::Value = serde_json::from_str(&rendered).unwrap();
    assert_eq!(emitted["timing"]["totalUs"], report.timing.total_us);
    assert_eq!(emitted["timing"]["renderUs"], report.timing.render_us);
    assert!(report.introduced_cycles[0].members.is_empty());
}

#[test]
fn irreducible_oversize_is_a_bounded_structured_failure() {
    for json in [false, true] {
        let started = Instant::now();
        let mut report =
            incomplete_report("oversize", "x".repeat(MAX_ASSESSMENT_BYTES + 1), started);
        let rendered = prepare_output(&mut report, json, started).unwrap();

        assert!(rendered.len() <= MAX_ASSESSMENT_BYTES);
        assert_eq!(report.status, SenseStatus::Incomplete);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].code, "output_too_large");
        if json {
            let emitted: SenseReport = serde_json::from_str(&rendered).unwrap();
            assert_eq!(emitted.status, SenseStatus::Incomplete);
            assert_eq!(emitted.issues[0].code, "output_too_large");
            assert_eq!(emitted.timing.total_us, report.timing.total_us);
            assert_eq!(emitted.timing.render_us, report.timing.render_us);
        } else {
            assert!(rendered.contains("output_too_large"));
        }
    }
}

#[test]
fn human_output_rejects_complete_paths_that_cannot_fit_json() {
    let started = Instant::now();
    let mut report = incomplete_report("limit", "limit".into(), started);
    report.issues[0].paths = (0..2_100)
        .map(|index| {
            let mut bytes = format!("path-{index:04}-").into_bytes();
            bytes.resize(MAX_REPOSITORY_PATH_BYTES, b'x');
            RepoPath::new(bytes).unwrap()
        })
        .collect();

    let rendered = prepare_output(&mut report, false, started).unwrap();
    assert_eq!(report.status, SenseStatus::Incomplete);
    assert_eq!(report.issues.len(), 1);
    assert_eq!(report.issues[0].code, "output_too_large");
    assert!(rendered.contains("output_too_large"));
    assert!(!rendered.contains("complete bounded evidence is available with --json"));
}

#[test]
fn human_issue_paths_only_advertise_complete_json_when_retained() {
    let started = Instant::now();
    let paths = (0..6)
        .map(|index| RepoPath::new(format!("path-{index}.js").into_bytes()).unwrap())
        .collect::<Vec<_>>();
    let mut complete = incomplete_report("complete", "complete".into(), started);
    complete.issues[0].paths = paths.clone();
    let rendered = human_output(&complete);
    assert!(rendered.contains("showing 5 of 6"));
    assert!(rendered.contains("complete bounded evidence is available with --json"));
    complete.issues[0].paths = paths;
    complete.issues[0].paths_truncated = true;
    let rendered = human_output(&complete);
    assert!(rendered.contains(
        "affected: path-0.js, path-1.js, path-2.js, path-3.js, path-4.js (sample truncated)"
    ));
    assert!(!rendered.contains("JSON evidence"));
}

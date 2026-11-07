use std::{fmt::Write as _, sync::Arc};

use super::*;
use crate::{analysis, cancel::CancelToken, limits::RuleLimits, model::Language};

fn evaluate_regions<'a>(
    before: &'a SourceSnapshot,
    after: &'a SourceSnapshot,
    file_facts: &'a facts::FactMap,
    fact_keys: &'a FactKeyLookup,
    changed_paths: &'a BTreeSet<RepoPath>,
) -> RegionResult {
    region_findings(RegionInputs {
        before,
        after,
        file_facts,
        fact_keys,
        changed_paths,
        continuity: &BTreeMap::new(),
        suppressed_paths: &BTreeSet::new(),
        callable_findings: &[],
        finding_limit: 32,
    })
}

fn source(path: &str, prefix: &str) -> SourceFile {
    let mut text = format!("export function {prefix}() {{\n  let value = 0;\n");
    for index in 0..20 {
        writeln!(text, "  value = value + {prefix}_{index};").unwrap();
    }
    text.push_str("  return value;\n}\n");
    SourceFile::new(
        RepoPath::from_protocol(path).unwrap(),
        text.into_bytes(),
        Language::TypeScript,
        "typescript".into(),
    )
}

fn single_file_region_state(file: &SourceFile) -> (SourceSnapshot, facts::FactMap, FactKeyLookup) {
    let options = serde_json::to_vec(&RuleLimits::default()).unwrap();
    let analyzed = analysis::analyze(file, &RuleLimits::default(), &CancelToken::new()).unwrap();
    let snapshot = SourceSnapshot::new([file.clone()]);
    let key = facts::key(file, &options);
    let file_facts = facts::FactMap::from([(key, Arc::new(analyzed))]);
    let fact_keys = FactKeyLookup::from([(
        file.content_id,
        BTreeMap::from([(file.language_mode.clone(), key)]),
    )]);
    (snapshot, file_facts, fact_keys)
}

#[test]
fn exact_comparison_limit_reports_bounded_paths_and_recovery() {
    let files = (0..6)
        .map(|index| source(&format!("path-{index}.ts"), "alpha"))
        .collect::<Vec<_>>();
    let options = serde_json::to_vec(&RuleLimits::default()).unwrap();
    let snapshot = SourceSnapshot::new(files.clone());
    let mut file_facts = facts::FactMap::new();
    let mut fact_keys = FactKeyLookup::new();
    for file in &files {
        let analyzed =
            analysis::analyze(file, &RuleLimits::default(), &CancelToken::new()).unwrap();
        let key = facts::key(file, &options);
        file_facts.insert(key, Arc::new(analyzed));
        fact_keys.insert(
            file.content_id,
            BTreeMap::from([(file.language_mode.clone(), key)]),
        );
    }
    let decoded_evidence = Rc::new(RefCell::new(DecodedEvidence::default()));
    let view = RegionView::new(&RegionViewInputs {
        view: SenseView::After,
        snapshot: &snapshot,
        file_facts: &file_facts,
        fact_keys: &fact_keys,
        continuity: &BTreeMap::new(),
        decoded_evidence: Rc::clone(&decoded_evidence),
    });
    let mut comparison = ComparisonState {
        remaining: 0,
        ..ComparisonState::default()
    };
    for file in 0..files.len() {
        let location = TokenLocation { file, token: 0 };
        assert_eq!(
            comparison.tokens_equal(TokenPair::same_view(&view, location, location)),
            None
        );
    }

    let issue = comparison.limit_issue().unwrap();
    assert_eq!(
        issue.paths,
        files
            .into_iter()
            .take(MAX_OBSERVATION_PATHS)
            .map(|file| file.path)
            .collect::<Vec<_>>()
    );
    assert_eq!(issue.stage, Some(DedupLimitStage::ExactTokenComparison));
    assert_eq!(issue.views, vec![SenseView::After]);
    assert_eq!(issue.limit, Some(MAX_DEDUP_TOKEN_COMPARISONS));
    assert_eq!(issue.processed, Some(MAX_DEDUP_TOKEN_COMPARISONS));
    assert!(issue.paths_truncated);
    let next_step = issue.next_step.unwrap();
    assert!(next_step.contains("targets.exclude"));
    let docs_route = format!(
        "/v{}.{}/docs/configuration.html#select-targets",
        env!("CARGO_PKG_VERSION_MAJOR"),
        env!("CARGO_PKG_VERSION_MINOR")
    );
    assert!(next_step.contains(&docs_route));
}

#[test]
fn malformed_exact_token_evidence_has_a_distinct_fail_closed_issue() {
    let alpha = source("alpha.ts", "alpha");
    let options = serde_json::to_vec(&RuleLimits::default()).unwrap();
    let mut analyzed =
        analysis::analyze(&alpha, &RuleLimits::default(), &CancelToken::new()).unwrap();
    assert!(!analyzed.region_fingerprints.anchors.is_empty());
    analyzed.region_fingerprints.encoded_tokens = "not-base64".into();
    let snapshot = SourceSnapshot::new([alpha.clone()]);
    let key = facts::key(&alpha, &options);
    let file_facts = facts::FactMap::from([(key, Arc::new(analyzed))]);
    let fact_keys = FactKeyLookup::from([(
        alpha.content_id,
        BTreeMap::from([(alpha.language_mode.clone(), key)]),
    )]);
    let result = evaluate_regions(
        &SourceSnapshot::new([]),
        &snapshot,
        &file_facts,
        &fact_keys,
        &BTreeSet::from([alpha.path.clone()]),
    );

    assert!(result.findings.is_empty());
    assert_eq!(result.comparison_issues.len(), 1);
    assert_eq!(
        result.comparison_issues[0].code,
        "dedup_exact_evidence_malformed"
    );
    assert_eq!(result.comparison_issues[0].views, vec![SenseView::After]);
    assert_eq!(result.comparison_issues[0].paths, vec![alpha.path]);
    assert!(result.after.malformed_evidence);
    assert_eq!(result.after.anchors, 0);
    assert!(!result.after.request_truncated);
}

#[test]
fn malformed_token_location_marks_only_the_failing_view() {
    let before_file = source("before.ts", "before");
    let after_file = source("after.ts", "after");
    let (before_snapshot, before_facts, before_keys) = single_file_region_state(&before_file);
    let (after_snapshot, after_facts, after_keys) = single_file_region_state(&after_file);
    let decoded_evidence = Rc::new(RefCell::new(DecodedEvidence::default()));
    let before = RegionView::new(&RegionViewInputs {
        view: SenseView::Before,
        snapshot: &before_snapshot,
        file_facts: &before_facts,
        fact_keys: &before_keys,
        continuity: &BTreeMap::new(),
        decoded_evidence: Rc::clone(&decoded_evidence),
    });
    let after = RegionView::new(&RegionViewInputs {
        view: SenseView::After,
        snapshot: &after_snapshot,
        file_facts: &after_facts,
        fact_keys: &after_keys,
        continuity: &BTreeMap::new(),
        decoded_evidence: Rc::clone(&decoded_evidence),
    });
    let mut comparison = ComparisonState::default();

    assert_eq!(
        comparison.tokens_equal(TokenPair {
            left_view: &before,
            left: TokenLocation {
                file: 0,
                token: usize::MAX,
            },
            right_view: &after,
            right: TokenLocation { file: 0, token: 0 },
        }),
        None
    );
    let issue = comparison.issues().pop().unwrap();
    assert_eq!(issue.views, vec![SenseView::Before]);
    assert_eq!(issue.paths, vec![before_file.path]);

    let mut before_coverage = FingerprintCoverage::default();
    before.coverage(&comparison).apply(&mut before_coverage);
    let mut after_coverage = FingerprintCoverage::default();
    after.coverage(&comparison).apply(&mut after_coverage);
    assert!(before_coverage.malformed_evidence);
    assert!(!after_coverage.malformed_evidence);
}

#[test]
fn anchor_hash_collision_cannot_become_a_region_finding() {
    let alpha = source("alpha.ts", "alpha");
    let beta = source("beta.ts", "beta");
    let options = serde_json::to_vec(&RuleLimits::default()).unwrap();
    let mut alpha_facts =
        analysis::analyze(&alpha, &RuleLimits::default(), &CancelToken::new()).unwrap();
    let mut beta_facts =
        analysis::analyze(&beta, &RuleLimits::default(), &CancelToken::new()).unwrap();
    let alpha_anchor = alpha_facts.region_fingerprints.anchors[0];
    let beta_anchor = beta_facts.region_fingerprints.anchors[0];
    alpha_facts.region_fingerprints.anchors = vec![alpha_anchor];
    beta_facts.region_fingerprints.anchors = vec![crate::model::RegionFingerprint {
        hash_one: alpha_anchor.hash_one,
        hash_two: alpha_anchor.hash_two,
        token_index: beta_anchor.token_index,
    }];

    let after = SourceSnapshot::new([alpha.clone(), beta.clone()]);
    let before = SourceSnapshot::new([]);
    let mut file_facts = facts::FactMap::new();
    file_facts.insert(facts::key(&alpha, &options), Arc::new(alpha_facts));
    file_facts.insert(facts::key(&beta, &options), Arc::new(beta_facts));
    let mut fact_keys = FactKeyLookup::new();
    for file in [&alpha, &beta] {
        fact_keys
            .entry(file.content_id)
            .or_default()
            .insert(file.language_mode.clone(), facts::key(file, &options));
    }
    let changed_paths = BTreeSet::from([alpha.path.clone(), beta.path.clone()]);
    let result = evaluate_regions(&before, &after, &file_facts, &fact_keys, &changed_paths);

    assert!(result.findings.is_empty());
    assert!(!result.after.request_truncated);
}

#[test]
fn unchanged_anchor_count_cannot_hide_an_introduced_exact_region() {
    let alpha = source("alpha.ts", "shared");
    let before_beta = source("beta.ts", "different");
    let after_beta = SourceFile::new(
        before_beta.path.clone(),
        alpha.bytes.clone(),
        alpha.language,
        alpha.language_mode.clone(),
    );
    let options = serde_json::to_vec(&RuleLimits::default()).unwrap();
    let alpha_facts =
        analysis::analyze(&alpha, &RuleLimits::default(), &CancelToken::new()).unwrap();
    let mut before_beta_facts =
        analysis::analyze(&before_beta, &RuleLimits::default(), &CancelToken::new()).unwrap();
    assert_eq!(
        alpha_facts.region_fingerprints.anchors.len(),
        before_beta_facts.region_fingerprints.anchors.len()
    );
    for (anchor, replacement) in before_beta_facts
        .region_fingerprints
        .anchors
        .iter_mut()
        .zip(&alpha_facts.region_fingerprints.anchors)
    {
        anchor.hash_one = replacement.hash_one;
        anchor.hash_two = replacement.hash_two;
    }

    let before = SourceSnapshot::new([alpha.clone(), before_beta.clone()]);
    let after = SourceSnapshot::new([alpha.clone(), after_beta.clone()]);
    let mut file_facts = facts::FactMap::new();
    file_facts.insert(facts::key(&alpha, &options), Arc::new(alpha_facts.clone()));
    file_facts.insert(
        facts::key(&before_beta, &options),
        Arc::new(before_beta_facts),
    );
    let mut fact_keys = FactKeyLookup::new();
    for file in [&alpha, &before_beta, &after_beta] {
        fact_keys
            .entry(file.content_id)
            .or_default()
            .insert(file.language_mode.clone(), facts::key(file, &options));
    }
    let changed_paths = BTreeSet::from([after_beta.path.clone()]);
    let result = evaluate_regions(&before, &after, &file_facts, &fact_keys, &changed_paths);

    assert_eq!(result.findings.len(), 1);
    assert_eq!(result.findings[0].before_count, 1);
    assert_eq!(result.findings[0].after_count, 2);
    assert!(!result.after.request_truncated);
}

fn analyzed_views(files: &[SourceFile]) -> (facts::FactMap, FactKeyLookup) {
    let options = serde_json::to_vec(&RuleLimits::default()).unwrap();
    let mut file_facts = facts::FactMap::new();
    let mut fact_keys = FactKeyLookup::new();
    for file in files {
        let key = facts::key(file, &options);
        let analyzed =
            analysis::analyze(file, &RuleLimits::default(), &CancelToken::new()).unwrap();
        file_facts.insert(key, Arc::new(analyzed));
        fact_keys
            .entry(file.content_id)
            .or_default()
            .insert(file.language_mode.clone(), key);
    }
    (file_facts, fact_keys)
}

fn finding_json(result: &RegionResult) -> serde_json::Value {
    serde_json::to_value(&result.findings).unwrap()
}

#[test]
fn batched_regions_preserve_findings_order_cardinality_and_rename_continuity() {
    let alpha = source("old/alpha.ts", "alpha");
    let beta = source("lib/beta.ts", "beta");
    let alpha_copy = source("new/alpha-copy.ts", "alpha");
    // Keep the exact region but vary the whole file, so file equality cannot suppress it.
    let alpha_copy = SourceFile::new(
        alpha_copy.path,
        [alpha_copy.bytes.as_ref(), b"// copy\n"].concat(),
        Language::TypeScript,
        "typescript".into(),
    );
    let moved = SourceFile::new(
        RepoPath::from_protocol("moved/beta.ts").unwrap(),
        beta.bytes.clone(),
        Language::TypeScript,
        "typescript".into(),
    );
    let beta_copy = source("other/beta-copy.ts", "beta");
    let beta_copy = SourceFile::new(
        beta_copy.path,
        [beta_copy.bytes.as_ref(), b"// second\n"].concat(),
        Language::TypeScript,
        "typescript".into(),
    );
    let before = SourceSnapshot::new([alpha.clone(), beta.clone()]);
    let after = SourceSnapshot::new([
        alpha.clone(),
        alpha_copy.clone(),
        moved.clone(),
        beta_copy.clone(),
    ]);
    let (file_facts, fact_keys) = analyzed_views(&[
        alpha,
        beta.clone(),
        alpha_copy.clone(),
        moved.clone(),
        beta_copy.clone(),
    ]);
    let continuity = BTreeMap::from([(beta.path, moved.path.clone())]);
    let changed_paths = BTreeSet::from([alpha_copy.path, moved.path, beta_copy.path]);
    let inputs = RegionInputs {
        before: &before,
        after: &after,
        file_facts: &file_facts,
        fact_keys: &fact_keys,
        changed_paths: &changed_paths,
        continuity: &continuity,
        suppressed_paths: &BTreeSet::new(),
        callable_findings: &[],
        finding_limit: 32,
    };
    for finding_limit in [32, 1] {
        let inputs = RegionInputs {
            finding_limit,
            ..inputs
        };
        let unbatched = region_findings_bounded(inputs, usize::MAX);
        let batched = region_findings_bounded(inputs, 8);
        assert_eq!(unbatched.findings.len(), finding_limit.min(2));
        assert_eq!(finding_json(&batched), finding_json(&unbatched));
        assert_eq!(batched.findings_truncated, unbatched.findings_truncated);
        assert!(batched.comparison_issues.is_empty());
        assert_eq!(batched.before, unbatched.before);
        assert_eq!(batched.after, unbatched.after);
    }
}

#[test]
fn unsplittable_anchor_class_retains_complete_limit_evidence() {
    let files = (0..7)
        .map(|index| source(&format!("dir-{index}/file.ts"), "shared"))
        .collect::<Vec<_>>();
    let snapshot = SourceSnapshot::new(files.clone());
    let (mut file_facts, fact_keys) = analyzed_views(&files);
    for facts in file_facts.values_mut() {
        let facts = Arc::make_mut(facts);
        facts.region_fingerprints.anchors.truncate(1);
    }
    let result = region_findings_bounded(
        RegionInputs {
            before: &SourceSnapshot::new([]),
            after: &snapshot,
            file_facts: &file_facts,
            fact_keys: &fact_keys,
            changed_paths: &files.iter().map(|f| f.path.clone()).collect(),
            continuity: &BTreeMap::new(),
            suppressed_paths: &BTreeSet::new(),
            callable_findings: &[],
            finding_limit: 32,
        },
        1,
    );
    assert!(result.after.request_truncated);
    let issue = &result.comparison_issues[0];
    assert_eq!(issue.code, "dedup_region_request_limit");
    assert_eq!(
        issue.stage,
        Some(DedupLimitStage::TokenRegionRequestCollection)
    );
    assert_eq!(issue.views, vec![SenseView::After]);
    assert_eq!(issue.limit, Some(1));
    assert_eq!(issue.processed, Some(1));
    assert_eq!(
        issue.paths,
        files
            .iter()
            .skip(1)
            .map(|f| f.path.clone())
            .collect::<Vec<_>>()
    );
    assert!(!issue.paths_truncated);
}

fn comparison_views<'a>(
    before: &'a SourceSnapshot,
    after: &'a SourceSnapshot,
    file_facts: &facts::FactMap,
    fact_keys: &FactKeyLookup,
) -> [RegionView<'a>; 2] {
    let decoded = Rc::new(RefCell::new(DecodedEvidence::default()));
    [SenseView::Before, SenseView::After].map(|view| {
        RegionView::new(&RegionViewInputs {
            view,
            snapshot: if view == SenseView::Before {
                before
            } else {
                after
            },
            file_facts,
            fact_keys,
            continuity: &BTreeMap::new(),
            decoded_evidence: Rc::clone(&decoded),
        })
    })
}

fn with_batch_inputs(files: &[SourceFile], evaluate: impl FnOnce(RegionInputs<'_>)) {
    let before = SourceSnapshot::new([]);
    let after = SourceSnapshot::new(files.to_vec());
    let (file_facts, fact_keys) = analyzed_views(files);
    evaluate(RegionInputs {
        before: &before,
        after: &after,
        file_facts: &file_facts,
        fact_keys: &fact_keys,
        changed_paths: &files.iter().map(|file| file.path.clone()).collect(),
        continuity: &BTreeMap::new(),
        suppressed_paths: &BTreeSet::new(),
        callable_findings: &[],
        finding_limit: 32,
    });
}

#[test]
fn unique_anchors_are_indexed_once_without_decoding_across_batch_sizes() {
    let files = (0..40)
        .map(|index| source(&format!("file-{index}.ts"), &format!("unique{index}")))
        .collect::<Vec<_>>();
    with_batch_inputs(&files, |inputs| {
        for limit in [32, 64, usize::MAX] {
            let mut views = comparison_views(
                inputs.before,
                inputs.after,
                inputs.file_facts,
                inputs.fact_keys,
            );
            let anchors = views[1].retained_anchors;
            assert!(anchors > 64);
            let mut state = EvaluationState::default();
            batches::evaluate(inputs, limit, &mut views, &mut state);
            assert!(!state.comparison.incomplete);
            assert!(state.findings.is_empty());
            assert_eq!(views[1].indexed, anchors);
            let cache = views[1].decoded_evidence.borrow();
            assert_eq!(cache.decodes, 0);
            assert_eq!(
                cache.live.peak.load(std::sync::atomic::Ordering::Relaxed),
                0
            );
        }
    });
}

fn with_evidence_view<T>(files: &[SourceFile], evaluate: impl FnOnce(&RegionView<'_>) -> T) -> T {
    let snapshot = SourceSnapshot::new(files.to_vec());
    let (file_facts, fact_keys) = analyzed_views(files);
    let views = comparison_views(&snapshot, &snapshot, &file_facts, &fact_keys);
    evaluate(&views[1])
}

#[test]
fn lazy_evidence_bounds_live_buffers() {
    let files = (0..12)
        .map(|index| source(&format!("dense-{index}.ts"), &format!("dense{index}")))
        .collect::<Vec<_>>();
    let tracker = with_evidence_view(&files, |view| {
        let tracker = Arc::clone(&view.decoded_evidence.borrow().live);
        // Holding the current pair must never leave a third live buffer after eviction.
        for peer in 1..files.len() {
            let candidate = view.tokens(0).unwrap();
            let other = view.tokens(peer).unwrap();
            assert!(!candidate.tokens.is_empty() && !other.tokens.is_empty());
            assert_eq!(
                tracker.current.load(std::sync::atomic::Ordering::Relaxed),
                2
            );
        }
        assert_eq!(tracker.peak.load(std::sync::atomic::Ordering::Relaxed), 2);
        tracker
    });
    assert_eq!(
        tracker.current.load(std::sync::atomic::Ordering::Relaxed),
        0
    );
}

#[test]
fn decode_work_is_reserved_before_allocation_under_cache_thrashing() {
    let padding = format!("// {}\n", "x".repeat(1_000)).repeat(1_024);
    for comments in ["", padding.as_str()] {
        let files = (0..3)
            .map(|index| {
                let file = source(&format!("thrash-{index}.ts"), &format!("variant{index}"));
                SourceFile::new(
                    file.path,
                    [file.bytes.as_ref(), comments.as_bytes()].concat(),
                    Language::TypeScript,
                    "typescript".into(),
                )
            })
            .collect::<Vec<_>>();
        with_evidence_view(&files, |view| {
            let budget = view
                .files
                .iter()
                .map(|file| {
                    DecodedTokens::decode_cost(file.source, &file.facts.region_fingerprints)
                })
                .sum::<usize>();
            assert!(budget >= comments.len() * files.len());
            {
                let mut cache = view.decoded_evidence.borrow_mut();
                cache.decode_remaining = budget;
                cache.decode_limit = budget;
            }
            let mut comparison = ComparisonState::default();
            for file in [0, 1, 1, 2, 2] {
                assert!(comparison.token_exists(view, file, 0));
            }
            assert_eq!(view.decoded_evidence.borrow().decodes, 3);
            // File 0 was evicted; this fourth decode must fail before allocating token records.
            assert!(!comparison.token_exists(view, 0, 0));
            assert_eq!(view.decoded_evidence.borrow().decodes, 3);
            assert!(comparison.incomplete);
            assert!(!comparison.malformed_evidence);
            let issue = comparison.limit_issue().unwrap();
            assert_eq!(issue.code, "dedup_exact_decode_limit");
            assert_eq!(issue.stage, Some(DedupLimitStage::ExactEvidenceDecoding));
            assert_eq!(issue.limit, Some(budget));
            assert_eq!(issue.processed, Some(budget));
            assert!(view.coverage(&comparison).request_truncated);
        });
    }
}

#[test]
fn exact_comparison_budget_is_shared_across_all_batches() {
    let files = [
        source("a.ts", "shared"),
        source("b.ts", "shared"),
        source("c.ts", "other"),
        source("d.ts", "other"),
    ];
    with_batch_inputs(&files, |inputs| {
        let mut views = comparison_views(
            inputs.before,
            inputs.after,
            inputs.file_facts,
            inputs.fact_keys,
        );
        let mut unbatched = EvaluationState::default();
        batches::evaluate(inputs, usize::MAX, &mut views, &mut unbatched);
        let required = MAX_DEDUP_TOKEN_COMPARISONS - unbatched.comparison.remaining;
        assert!(required > 1);
        let mut views = comparison_views(
            inputs.before,
            inputs.after,
            inputs.file_facts,
            inputs.fact_keys,
        );
        let mut batched = EvaluationState::default();
        batches::evaluate(inputs, 8, &mut views, &mut batched);
        assert_eq!(batched.comparison.remaining, unbatched.comparison.remaining);
        let mut views = comparison_views(
            inputs.before,
            inputs.after,
            inputs.file_facts,
            inputs.fact_keys,
        );
        let mut limited = EvaluationState::default();
        limited.comparison.remaining = required - 1;
        batches::evaluate(inputs, 8, &mut views, &mut limited);
        assert!(limited.comparison.incomplete && limited.comparison.limit_reached);
        assert_eq!(limited.comparison.remaining, 0);
    });
}

mod support;
use support::assert_fingerprints_parser_failed;

use opcore::api::test_support::{
    AnalysisError, CancelToken, DependencyExtractionStatus, DependencyReference,
    DependencyReferenceKind, FingerprintExtractionStatus, InterfaceExtractionStatus,
    InterfaceSurfaceStatus, Language, RepoPath, RuleLimits, SourceFile, rust,
};

fn source(text: &str, edition: &str) -> SourceFile {
    SourceFile::new(
        RepoPath::from_protocol("src/lib.rs").expect("fixture path"),
        text.as_bytes(),
        Language::Rust,
        edition.into(),
    )
}

fn rust_assignments(count: usize) -> String {
    use std::fmt::Write as _;

    let mut output = String::new();
    for index in 0..count {
        writeln!(output, "let value_{index} = input + {index};").unwrap();
    }
    output
}

#[test]
fn parses_supported_stable_editions_with_pinned_provenance() {
    for edition in ["2018", "2021", "2024"] {
        let facts = rust::analyze(
            &source("pub async fn value() -> usize { 1 }", edition),
            &RuleLimits::default(),
            &CancelToken::new(),
        )
        .unwrap_or_else(|error| panic!("edition {edition}: {error}"));
        assert_eq!(facts.parser, "ra_ap_syntax");
        assert_eq!(facts.parser_version, "0.0.344");
        assert!(facts.diagnostics.is_empty(), "edition {edition}");
        assert_eq!(
            facts.dependencies.status,
            DependencyExtractionStatus::Complete
        );
        assert_eq!(
            facts.interfaces.status,
            InterfaceExtractionStatus::Unsupported
        );
        assert_eq!(
            facts.interfaces.public_surface_status,
            InterfaceSurfaceStatus::Unsupported
        );
    }
}

#[test]
fn extracts_bounded_module_and_use_facts_without_external_guessing() {
    let facts = rust::analyze(
        &source(
            r#"
mod local;
mod inline {
    mod child;
    use self::child::Item;
    use super::local::{self as local_module, Item};
}
use crate::{inline::*, local::Thing};
use std::sync::Arc;
use ::external::Thing;
#[cfg(feature = "optional")]
mod optional;
#[path = "elsewhere.rs"]
mod redirected;
"#,
            "2021",
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .expect("Rust dependency facts");

    assert_eq!(
        facts.dependencies.status,
        DependencyExtractionStatus::Complete
    );
    for expected in [
        dependency(DependencyReferenceKind::RustModule, "inline::child"),
        dependency(DependencyReferenceKind::RustModule, "local"),
        dependency(DependencyReferenceKind::RustUse, "crate::inline"),
        dependency(DependencyReferenceKind::RustUse, "crate::local::Thing"),
        dependency(
            DependencyReferenceKind::RustUse,
            "self::inline::child::Item",
        ),
        dependency(DependencyReferenceKind::RustUse, "self::local"),
        dependency(DependencyReferenceKind::RustUse, "self::local::Item"),
        dependency(
            DependencyReferenceKind::RustUnsupported,
            "conditional_attribute",
        ),
        dependency(DependencyReferenceKind::RustUnsupported, "path_attribute"),
    ] {
        assert!(
            facts.dependencies.references.contains(&expected),
            "missing {expected:?} in {:?}",
            facts.dependencies.references
        );
    }
    assert!(
        facts
            .dependencies
            .references
            .iter()
            .all(|reference| !reference.specifier.contains("std")
                && !reference.specifier.contains("external")),
        "unexpected external fact in {:?}",
        facts.dependencies.references
    );
}

fn dependency(kind: DependencyReferenceKind, specifier: &str) -> DependencyReference {
    DependencyReference {
        kind,
        specifier: specifier.into(),
        level: 0,
    }
}

#[test]
fn rust_dependency_fact_overflow_is_explicit_and_bounded() {
    use std::fmt::Write as _;

    let mut input = String::new();
    for index in 0..=4_096 {
        writeln!(input, "use crate::module_{index}::Value;").unwrap();
    }
    let facts = rust::analyze(
        &source(&input, "2021"),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .expect("bounded Rust dependency extraction");

    assert_eq!(
        facts.dependencies.status,
        DependencyExtractionStatus::Truncated
    );
    assert_eq!(facts.dependencies.references.len(), 4_096);
}

#[test]
fn syntax_errors_are_ranged_and_suppress_recovered_metrics() {
    let facts = rust::analyze(
        &source("fn broken( {\n", "2021"),
        &RuleLimits {
            max_function_lines: 0,
            max_parameters: 0,
            max_nesting: 0,
            max_cyclomatic_complexity: 0,
            ..RuleLimits::default()
        },
        &CancelToken::new(),
    )
    .expect("syntax findings are analysis results");

    assert!(!facts.diagnostics.is_empty());
    assert!(
        facts
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.rule_id == "rust.syntax")
    );
    let first = &facts.diagnostics[0];
    assert!(first.range.is_some());
    assert_eq!(first.evidence["parser"], "ra_ap_syntax");
    assert_eq!(first.evidence["parserVersion"], "0.0.344");
    assert_eq!(first.evidence["edition"], "2021");
    assert_eq!(
        facts.dependencies.status,
        DependencyExtractionStatus::ParserFailed
    );
}

#[test]
fn reports_deterministic_function_metrics() {
    let fixture = r"fn complex(first: bool, second: bool, third: bool) {
    if first && second {
        for _ in 0..1 {
            while third {
                break;
            }
        }
    }
}";
    let limits = RuleLimits {
        max_function_lines: 4,
        max_parameters: 2,
        max_nesting: 2,
        max_cyclomatic_complexity: 4,
        ..RuleLimits::default()
    };
    let first = rust::analyze(&source(fixture, "2021"), &limits, &CancelToken::new())
        .expect("first analysis");
    let second = rust::analyze(&source(fixture, "2021"), &limits, &CancelToken::new())
        .expect("second analysis");
    assert_eq!(first, second);

    let rules = first
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.rule_id.as_str())
        .collect::<Vec<_>>();
    assert!(rules.contains(&"complexity.max-function-lines"));
    assert!(rules.contains(&"complexity.max-parameters"));
    assert!(rules.contains(&"complexity.max-nesting"));
    assert!(rules.contains(&"complexity.max-cyclomatic-complexity"));

    let complexity = first
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.rule_id == "complexity.max-cyclomatic-complexity")
        .expect("complexity diagnostic");
    assert_eq!(complexity.evidence["actual"], 5);
    assert_eq!(
        complexity.evidence["metricSemantics"],
        "opcore.rust-metrics.v1"
    );
    let nesting = first
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.rule_id == "complexity.max-nesting")
        .expect("nesting diagnostic");
    assert_eq!(nesting.evidence["actual"], 3);
    let parameters = first
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.rule_id == "complexity.max-parameters")
        .expect("parameter diagnostic");
    assert_eq!(parameters.evidence["actual"], 3);
    assert_eq!(parameters.evidence["receiverExcluded"], true);
}

#[test]
fn closures_are_measured_separately_from_their_parent() {
    let fixture = r"fn outer() {
    let predicate = |left: bool, right: bool| {
        if left {
            if right { return true; }
        }
        false
    };
}";
    let facts = rust::analyze(
        &source(fixture, "2024"),
        &RuleLimits {
            max_function_lines: 100,
            max_parameters: 1,
            max_nesting: 1,
            max_cyclomatic_complexity: 2,
            ..RuleLimits::default()
        },
        &CancelToken::new(),
    )
    .expect("closure analysis");

    for rule in [
        "complexity.max-parameters",
        "complexity.max-nesting",
        "complexity.max-cyclomatic-complexity",
    ] {
        let matching = facts
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.rule_id == rule)
            .collect::<Vec<_>>();
        assert_eq!(matching.len(), 1, "{rule}: {matching:?}");
        assert_eq!(matching[0].evidence["entityKind"], "closure");
    }
}

#[test]
fn callable_fingerprints_ignore_names_comments_and_formatting_and_skip_nested_closures() {
    let statements = rust_assignments(16);
    let first = rust::analyze(
        &source(
            &format!("fn first(input: i32) -> i32 {{\n{statements}\nvalue_15\n}}"),
            "2021",
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .unwrap();
    let second = rust::analyze(
        &source(
            &format!("fn second(input: i32) -> i32 {{ {statements} /* ignored */ value_15 }}"),
            "2021",
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .unwrap();
    assert_eq!(
        first.callable_fingerprints.status,
        FingerprintExtractionStatus::Complete
    );
    assert_eq!(first.callable_fingerprints.callables.len(), 1);
    assert_eq!(
        first.callable_fingerprints.callables[0].digest,
        second.callable_fingerprints.callables[0].digest
    );

    let nested = rust::analyze(
        &source(
            &format!(
                "fn outer(input: i32) -> i32 {{ let inner = || {{ {statements} value_15 }}; inner() }}"
            ),
            "2021",
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .unwrap();
    assert_eq!(nested.callable_fingerprints.callables.len(), 1);
}

#[test]
fn callable_fingerprints_are_parser_failed_for_invalid_source() {
    let facts = rust::analyze(
        &source("fn broken( {", "2021"),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .unwrap();
    assert_fingerprints_parser_failed(&facts);
}

#[test]
fn macro_bodies_are_opaque_to_metrics() {
    let fixture = "fn wrapped() { check!({ if first && second { while third {} } }); }";
    let facts = rust::analyze(
        &source(fixture, "2021"),
        &RuleLimits {
            max_function_lines: 100,
            max_parameters: 5,
            max_nesting: 0,
            max_cyclomatic_complexity: 1,
            ..RuleLimits::default()
        },
        &CancelToken::new(),
    )
    .expect("macro analysis");

    assert!(facts.diagnostics.is_empty(), "{:?}", facts.diagnostics);

    let limited = rust::analyze(
        &source(fixture, "2021"),
        &RuleLimits {
            max_function_lines: 0,
            ..RuleLimits::default()
        },
        &CancelToken::new(),
    )
    .expect("macro evidence analysis");
    let line_finding = limited
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.rule_id == "complexity.max-function-lines")
        .expect("line finding");
    assert_eq!(line_finding.evidence["macroBodiesOpaque"], true);
    assert_eq!(line_finding.evidence["opaqueMacroCount"], 1);
}

#[test]
fn handles_bom_stable_feature_detection_and_rust_2018_prefixes() {
    let bom = SourceFile::new(
        RepoPath::from_protocol("src/lib.rs").unwrap(),
        b"\xef\xbb\xbfpub fn value() {}".as_slice(),
        Language::Rust,
        "2021".into(),
    );
    let facts = rust::analyze(&bom, &RuleLimits::default(), &CancelToken::new()).unwrap();
    assert!(facts.diagnostics.is_empty());

    let raw = source("const TEXT: &str = r#\"#![feature(test)]\"#;", "2021");
    assert!(
        rust::analyze(&raw, &RuleLimits::default(), &CancelToken::new())
            .unwrap()
            .diagnostics
            .is_empty()
    );
    let nightly = source("#! [ feature(test) ]\npub fn value() {}", "2021");
    assert!(matches!(
        rust::analyze(&nightly, &RuleLimits::default(), &CancelToken::new()),
        Err(AnalysisError::Unsupported(_))
    ));

    let prefix = source(
        "macro_rules! take { ($a:tt $b:tt) => {} }\ntake!(prefix\"literal\");",
        "2018",
    );
    assert!(
        rust::analyze(&prefix, &RuleLimits::default(), &CancelToken::new())
            .unwrap()
            .diagnostics
            .is_empty()
    );
}

#[test]
fn rejects_excessive_structure_before_recursive_parser_work() {
    let text = format!(
        "pub fn value() {{ let _ = {}1{}; }}",
        "(".repeat(300),
        ")".repeat(300)
    );
    assert!(matches!(
        rust::analyze(&source(&text, "2021"), &RuleLimits::default(), &CancelToken::new()),
        Err(AnalysisError::Unsupported(message)) if message.contains("structural depth")
    ));
}

#[test]
fn rejects_excessive_generic_depth_before_recursive_parser_work() {
    let text = format!(
        "pub type Deep = {}u8{};",
        "Vec<".repeat(300),
        ">".repeat(300)
    );
    assert!(matches!(
        rust::analyze(&source(&text, "2024"), &RuleLimits::default(), &CancelToken::new()),
        Err(AnalysisError::Unsupported(message)) if message.contains("structural depth")
    ));
}

#[test]
fn rejects_excessive_binary_chain_before_recursive_parser_work() {
    let text = format!("pub fn value() -> i32 {{ {}1 }}", "1 + ".repeat(300));
    assert!(matches!(
        rust::analyze(&source(&text, "2024"), &RuleLimits::default(), &CancelToken::new()),
        Err(AnalysisError::Unsupported(message)) if message.contains("structural depth")
    ));
}

#[test]
fn block_operands_cannot_reset_the_binary_chain_safety_limit() {
    let text = format!("pub fn value() -> i32 {{ 1{} }}", " + { 1 }".repeat(300));
    assert!(matches!(
        rust::analyze(&source(&text, "2024"), &RuleLimits::default(), &CancelToken::new()),
        Err(AnalysisError::Unsupported(message)) if message.contains("structural depth")
    ));
}

#[test]
fn else_if_is_flat_nesting_and_cr_is_a_physical_line_ending() {
    let branches = concat!(
        "pub fn choose(v: i32) -> i32 { ",
        "if v == 0 { 0 } else if v == 1 { 1 } else if v == 2 { 2 } ",
        "else if v == 3 { 3 } else if v == 4 { 4 } else { 5 } }",
    );
    let facts = rust::analyze(
        &source(branches, "2024"),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .unwrap();
    assert!(
        facts
            .diagnostics
            .iter()
            .all(|diagnostic| { diagnostic.rule_id != "complexity.max-nesting" })
    );

    let mut cr = String::from("pub fn long() {");
    for value in 0..100 {
        std::fmt::Write::write_fmt(&mut cr, format_args!("\r    let _v{value} = {value};"))
            .unwrap();
    }
    cr.push_str("\r}\r");
    let facts = rust::analyze(
        &source(&cr, "2024"),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .unwrap();
    assert!(
        facts
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.rule_id == "complexity.max-function-lines" })
    );
}

#[test]
fn callable_identity_includes_enclosing_module() {
    let limits = RuleLimits {
        max_parameters: 5,
        ..RuleLimits::default()
    };
    let first = rust::analyze(
        &source(
            "mod a { pub fn same(a:i32,b:i32,c:i32,d:i32,e:i32,f:i32) {} } mod b { pub fn same(a:i32) {} }",
            "2024",
        ),
        &limits,
        &CancelToken::new(),
    )
    .unwrap();
    let reordered = rust::analyze(
        &source(
            "mod b { pub fn same(a:i32) {} } mod a { pub fn same(a:i32,b:i32,c:i32,d:i32,e:i32,f:i32) {} }",
            "2024",
        ),
        &limits,
        &CancelToken::new(),
    )
    .unwrap();
    assert_eq!(first.diagnostics.len(), 1);
    assert_eq!(reordered.diagnostics.len(), 1);
    assert_eq!(
        first.diagnostics[0].entity_key,
        reordered.diagnostics[0].entity_key
    );
}

#[test]
fn method_receiver_is_not_counted_as_an_explicit_parameter() {
    let fixture = "impl Service { fn execute(&self, left: i32, right: i32) {} }";
    let facts = rust::analyze(
        &source(fixture, "2021"),
        &RuleLimits {
            max_parameters: 1,
            ..RuleLimits::default()
        },
        &CancelToken::new(),
    )
    .expect("method analysis");
    let parameters = facts
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.rule_id == "complexity.max-parameters")
        .expect("parameter finding");
    assert_eq!(parameters.evidence["actual"], 2);
    assert_eq!(parameters.evidence["receiverExcluded"], true);
}

#[test]
fn invalid_utf8_is_a_stable_syntax_result() {
    let file = SourceFile::new(
        RepoPath::from_protocol("src/lib.rs").expect("fixture path"),
        [b'f', b'n', b' ', 0xff],
        Language::Rust,
        "2021".into(),
    );
    let facts = rust::analyze(&file, &RuleLimits::default(), &CancelToken::new())
        .expect("invalid UTF-8 is a syntax finding");
    assert_eq!(facts.diagnostics.len(), 1);
    assert_eq!(facts.diagnostics[0].rule_id, "rust.syntax");
    assert_eq!(facts.diagnostics[0].evidence["errorKind"], "invalid_utf8");
    assert_eq!(
        facts.diagnostics[0]
            .range
            .expect("invalid byte range")
            .start
            .byte,
        3
    );
}

#[test]
fn rejects_unknown_language_modes_and_observes_cancellation() {
    let unsupported = rust::analyze(
        &source("fn value() {}", "nightly"),
        &RuleLimits::default(),
        &CancelToken::new(),
    );
    assert!(matches!(unsupported, Err(AnalysisError::Unsupported(_))));

    let cancel = CancelToken::new();
    cancel.cancel();
    let cancelled = rust::analyze(
        &source("fn value() {}", "2021"),
        &RuleLimits::default(),
        &cancel,
    );
    assert!(matches!(cancelled, Err(AnalysisError::Cancelled)));
}

mod support;

use std::fmt::Write as _;

use support::assert_fingerprints_parser_failed;

use opcore::api::test_support::{
    AnalysisError, CallableKind, CancelToken, DependencyExtractionStatus, DependencyReferenceKind,
    FingerprintExtractionStatus, InterfaceDeclarationKind, InterfaceExtractionStatus,
    InterfaceSelectorKind, InterfaceShapeKind, InterfaceSurfaceStatus, Language, RepoPath,
    RuleLimits, SourceFile, analyze_go_for_test,
};

fn source(path: &str, text: impl AsRef<[u8]>) -> SourceFile {
    let path = RepoPath::from_protocol(path).expect("fixture path");
    let kind = if path.as_utf8().unwrap().ends_with("_test.go") {
        "test"
    } else {
        "source"
    };
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        value => value,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "x86" => "386",
        value => value,
    };
    let mode = format!("go:{kind}:{os}:{arch}");
    SourceFile::new(path, text.as_ref(), Language::Go, mode)
}

#[test]
fn parses_current_go_syntax_with_pinned_provenance_and_facts() {
    let facts = analyze_go_for_test(
        &source(
            "service.go",
            r#"package service

import (
    _ "embed"
    alias "example.com/project/dependency"
)

type Public[T comparable] struct {
    Field T
    hidden string
}

type Contract interface {
    Apply(value int) error
}

const PublicConstant = 1
var PublicVariable = alias.Value

func PublicFunction[T any](left, right T, name string) T { return left }
func (receiver *Public[T]) ExportedMethod(value T) T { return value }
"#,
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .expect("valid Go analysis");

    assert!(facts.diagnostics.is_empty());
    assert_eq!(facts.parser, "tree-sitter-go");
    assert_eq!(facts.parser_version, "0.25.0");
    assert_eq!(
        facts.dependencies.status,
        DependencyExtractionStatus::Complete
    );
    let imports = facts
        .dependencies
        .references
        .iter()
        .map(|reference| (reference.kind, reference.specifier.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        imports,
        vec![
            (DependencyReferenceKind::GoImport, "embed"),
            (
                DependencyReferenceKind::GoImport,
                "example.com/project/dependency"
            ),
        ]
    );
    assert_eq!(facts.interfaces.status, InterfaceExtractionStatus::Complete);
    assert_eq!(
        facts.interfaces.public_surface_status,
        InterfaceSurfaceStatus::Complete
    );
    assert!(facts.interfaces.imports.iter().any(|import| {
        import.specifier == "embed" && import.selector.kind == InterfaceSelectorKind::SideEffect
    }));
    assert!(facts.interfaces.imports.iter().any(|import| {
        import.specifier == "example.com/project/dependency"
            && import.selector.kind == InterfaceSelectorKind::Namespace
            && import.selector.name == "alias"
    }));
    for (name, kind) in [
        ("Public", InterfaceDeclarationKind::Struct),
        ("Contract", InterfaceDeclarationKind::Interface),
        ("PublicConstant", InterfaceDeclarationKind::Constant),
        ("PublicVariable", InterfaceDeclarationKind::Variable),
        ("PublicFunction", InterfaceDeclarationKind::Function),
        ("Public.ExportedMethod", InterfaceDeclarationKind::Method),
    ] {
        assert!(
            facts
                .interfaces
                .exports
                .iter()
                .any(|item| { item.exported_name == name && item.declaration_kind == kind }),
            "missing {name}"
        );
    }
    assert!(facts.interfaces.shapes.iter().any(|shape| {
        shape.exported_name == "Public"
            && shape.kind == InterfaceShapeKind::Struct
            && shape.member_count == 2
    }));
    assert!(facts.interfaces.shapes.iter().any(|shape| {
        shape.exported_name == "Contract"
            && shape.kind == InterfaceShapeKind::Interface
            && shape.member_count == 1
    }));
}

#[test]
fn syntax_findings_are_ranged_and_suppress_recovered_facts() {
    let facts = analyze_go_for_test(
        &source("broken.go", "package broken\nfunc Broken( {\n"),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .expect("syntax failures are analysis results");

    assert!(!facts.diagnostics.is_empty());
    assert!(
        facts
            .diagnostics
            .iter()
            .all(|item| item.rule_id == "go.syntax")
    );
    assert!(facts.diagnostics[0].range.is_some());
    assert_eq!(facts.diagnostics[0].evidence["parser"], "tree-sitter-go");
    assert_eq!(facts.diagnostics[0].evidence["parserVersion"], "0.25.0");
    assert_eq!(
        facts.dependencies.status,
        DependencyExtractionStatus::ParserFailed
    );
    assert_fingerprints_parser_failed(&facts);
}

#[test]
fn reports_deterministic_function_and_method_metrics() {
    let fixture = r"package metrics

func Complex(first, second, third bool) {
    if first && second {
        for third {
            switch {
            case first:
                if second { return }
            default:
            }
        }
    }
}
";
    let limits = RuleLimits {
        max_function_lines: 5,
        max_parameters: 2,
        max_nesting: 2,
        max_cyclomatic_complexity: 5,
        ..RuleLimits::default()
    };
    let first = analyze_go_for_test(&source("metrics.go", fixture), &limits, &CancelToken::new())
        .expect("first metric pass");
    let second = analyze_go_for_test(&source("metrics.go", fixture), &limits, &CancelToken::new())
        .expect("second metric pass");
    assert_eq!(first, second);
    let rules = first
        .diagnostics
        .iter()
        .map(|item| item.rule_id.as_str())
        .collect::<Vec<_>>();
    for expected in [
        "complexity.max-function-lines",
        "complexity.max-parameters",
        "complexity.max-nesting",
        "complexity.max-cyclomatic-complexity",
    ] {
        assert!(rules.contains(&expected), "missing {expected}: {rules:?}");
    }
}

#[test]
fn nested_literals_are_omitted_from_the_enclosing_callable_fingerprint() {
    fn fixture(nested: &str) -> String {
        let statements = (0..64).fold(String::new(), |mut source, index| {
            writeln!(source, "value += input + {index}").unwrap();
            source
        });
        format!(
            "package duplicate\nfunc Outer(input int) int {{\n\
             value := 0\ninner := func() int {{ {nested} }}\n\
             _ = inner\n{statements}return value\n}}\n"
        )
    }
    let left = analyze_go_for_test(
        &source("left.go", fixture("return 1")),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .expect("left fingerprints");
    let right = analyze_go_for_test(
        &source("right.go", fixture("return 2 + 3")),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .expect("right fingerprints");
    let function = |facts: &opcore::api::test_support::FileFacts| {
        facts
            .callable_fingerprints
            .callables
            .iter()
            .find(|item| item.kind == CallableKind::Function)
            .expect("outer function fingerprint")
            .digest
            .clone()
    };
    assert_eq!(function(&left), function(&right));
    assert_eq!(
        left.callable_fingerprints.status,
        FingerprintExtractionStatus::Complete
    );
    assert_eq!(
        left.region_fingerprints.status,
        FingerprintExtractionStatus::Complete
    );
}

#[test]
fn build_constraints_never_become_guessed_runtime_edges() {
    let facts = analyze_go_for_test(
        &source(
            "conditional.go",
            "//go:build custom\n\npackage conditional\nimport \"example.com/project/local\"\n",
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .expect("conditional source");
    assert_eq!(
        facts.dependencies.references[0].kind,
        DependencyReferenceKind::GoUnsupportedConditional
    );
    assert_eq!(facts.interfaces.status, InterfaceExtractionStatus::Partial);
    assert_eq!(
        facts.interfaces.public_surface_status,
        InterfaceSurfaceStatus::Partial
    );
}

#[test]
fn standard_target_build_constraints_are_evaluated_without_a_go_toolchain() {
    let probe = source("target.go", "package target\n");
    let parts = probe.language_mode.split(':').collect::<Vec<_>>();
    let goos = parts[2];
    let other_goos = if goos == "windows" {
        "linux"
    } else {
        "windows"
    };
    let active = analyze_go_for_test(
        &source(
            "active.go",
            format!("//go:build {goos}\n\npackage active\nimport \"example.com/project/local\"\n"),
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .expect("active target constraint");
    assert_eq!(active.dependencies.references.len(), 1);
    assert_eq!(
        active.dependencies.references[0].kind,
        DependencyReferenceKind::GoImport
    );

    let inactive = analyze_go_for_test(
        &source(
            "inactive.go",
            format!(
                "//go:build {other_goos}\n\npackage inactive\nimport \"example.com/project/local\"\n"
            ),
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .expect("inactive target constraint");
    assert!(inactive.dependencies.references.is_empty());
    assert!(inactive.interfaces.exports.is_empty());
}

#[test]
fn test_files_keep_dependencies_but_do_not_project_production_exports() {
    let facts = analyze_go_for_test(
        &source(
            "service_test.go",
            "package service_test\nimport \"example.com/project/service\"\nfunc ExportedTestHelper() {}\n",
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .expect("Go test file");
    assert_eq!(facts.dependencies.references.len(), 1);
    assert!(facts.interfaces.exports.is_empty());
    assert!(facts.interfaces.shapes.is_empty());
}

#[test]
fn invalid_utf8_depth_mode_and_cancellation_fail_closed() {
    let invalid = analyze_go_for_test(
        &source("invalid.go", b"package invalid\n// \xff\n"),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .expect("invalid UTF-8 is a syntax result");
    assert_eq!(invalid.diagnostics[0].evidence["errorKind"], "invalid_utf8");

    let deep = format!(
        "package deep\nvar value = {}0{}\n",
        "(".repeat(257),
        ")".repeat(257)
    );
    assert!(matches!(
        analyze_go_for_test(
            &source("deep.go", deep),
            &RuleLimits::default(),
            &CancelToken::new()
        ),
        Err(AnalysisError::Unsupported(message)) if message.contains("structural depth")
    ));

    let mut unsupported = source("mode.go", "package mode\n");
    unsupported.language_mode = "go:unknown".into();
    assert!(matches!(
        analyze_go_for_test(&unsupported, &RuleLimits::default(), &CancelToken::new()),
        Err(AnalysisError::Unsupported(_))
    ));

    let cancelled = CancelToken::new();
    cancelled.cancel();
    assert!(matches!(
        analyze_go_for_test(
            &source("cancelled.go", "package cancelled\n"),
            &RuleLimits::default(),
            &cancelled
        ),
        Err(AnalysisError::Cancelled)
    ));
}

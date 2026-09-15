mod support;
use support::assert_fingerprints_parser_failed;

use opcore::api::test_support::{
    AnalysisError, CancelToken, DependencyExtractionStatus, DependencyReference,
    DependencyReferenceKind, FileFacts, FingerprintExtractionStatus, InterfaceExportNamespace,
    InterfaceExtractionStatus, InterfaceImportRole, InterfaceNamespace, InterfaceSelectorKind,
    InterfaceShapeKind, Language, RepoPath, RuleLimits, SourceFile, node,
};

fn source(path: &str, text: &str, language: Language) -> SourceFile {
    source_with_mode(path, text, language, "unambiguous")
}

fn source_with_mode(path: &str, text: &str, language: Language, language_mode: &str) -> SourceFile {
    SourceFile::new(
        RepoPath::from_protocol(path).expect("fixture path"),
        text.as_bytes(),
        language,
        language_mode.into(),
    )
}

fn analyze_typescript(path: &str, text: &str, limits: &RuleLimits) -> FileFacts {
    node::analyze(
        &source(path, text, Language::TypeScript),
        limits,
        &CancelToken::new(),
    )
    .unwrap()
}

fn assert_max_parameter_finding(facts: &FileFacts) {
    assert!(facts.diagnostics.iter().any(|diagnostic| {
        diagnostic.rule_id == "complexity.max-parameters" && diagnostic.evidence["actual"] == 6
    }));
}

fn assert_max_nesting_finding(facts: &FileFacts) {
    assert!(facts.diagnostics.iter().any(|diagnostic| {
        diagnostic.rule_id == "complexity.max-nesting" && diagnostic.evidence["actual"] == 5
    }));
}

fn javascript_assignments(count: usize) -> String {
    use std::fmt::Write as _;

    let mut output = String::new();
    for index in 0..count {
        writeln!(output, "const value{index} = input + {index};").unwrap();
    }
    output
}

#[test]
fn extracts_explicit_module_interface_facts_without_symbol_or_call_analysis() {
    let facts = node::analyze(
        &source(
            "src/interface.ts",
            r"
import primary, { type Shape, run, stop as halt } from './dependency';
import * as namespace from './wide';
import './setup';
interface Local { one: string; two(): void; }
type Options = { first: string; second: number; };
export { Local, type Options };
export { type Shape as PublicShape, run as publicRun } from './dependency';
export * from './barrel';
export default function service() { return primary; }
",
            Language::TypeScript,
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .unwrap();

    assert_eq!(facts.interfaces.status, InterfaceExtractionStatus::Partial);
    assert_eq!(facts.interfaces.gaps.namespace_imports, 1);
    assert_eq!(facts.interfaces.gaps.wildcard_exports, 1);
    assert!(facts.interfaces.imports.iter().any(|fact| {
        fact.specifier == "./dependency"
            && fact.role == InterfaceImportRole::Import
            && fact.namespace == InterfaceNamespace::TypeOnly
            && fact.selector.kind == InterfaceSelectorKind::Named
            && fact.selector.name == "Shape"
    }));
    assert!(facts.interfaces.imports.iter().any(|fact| {
        fact.specifier == "./dependency"
            && fact.role == InterfaceImportRole::Import
            && fact.namespace == InterfaceNamespace::Runtime
            && fact.selector.kind == InterfaceSelectorKind::Named
            && fact.selector.name == "run"
    }));
    assert!(facts.interfaces.exports.iter().any(|fact| {
        fact.exported_name == "Options" && fact.namespace == InterfaceExportNamespace::TypeOnly
    }));
    assert!(facts.interfaces.exports.iter().any(|fact| {
        fact.exported_name == "default" && fact.namespace == InterfaceExportNamespace::Value
    }));
    assert!(facts.interfaces.shapes.iter().any(|shape| {
        shape.exported_name == "Local"
            && shape.kind == InterfaceShapeKind::Interface
            && shape.member_count == 2
    }));
    assert!(facts.interfaces.shapes.iter().any(|shape| {
        shape.exported_name == "Options"
            && shape.kind == InterfaceShapeKind::TypeLiteralAlias
            && shape.member_count == 2
    }));
}

#[test]
fn exported_shape_fingerprint_ignores_layout_but_observes_same_size_signature_changes() {
    let fingerprint = |text: &str| {
        node::analyze(
            &source("src/interface.ts", text, Language::TypeScript),
            &RuleLimits::default(),
            &CancelToken::new(),
        )
        .unwrap()
        .interfaces
        .shapes
        .into_iter()
        .find(|shape| shape.exported_name == "Public")
        .unwrap()
        .fingerprint
    };

    let compact = fingerprint("export interface Public { first: string; second: number; }\n");
    let formatted = fingerprint(
        "export interface Public {\n  first: string; // layout only\n  second: number;\n}\n",
    );
    let changed = fingerprint("export interface Public { first: string; renamed: boolean; }\n");

    assert_eq!(compact, formatted);
    assert_ne!(compact, changed);
}

#[test]
fn interface_fact_overflow_is_explicit_and_bounded() {
    let declarations = (0..=opcore::api::test_support::MAX_INTERFACE_FACTS_PER_FILE)
        .map(|index| format!("v{index} = {index}"))
        .collect::<Vec<_>>()
        .join(",");
    let source_text = format!("export const {declarations};\n");
    let facts = node::analyze(
        &source(
            "src/interface-overflow.ts",
            &source_text,
            Language::TypeScript,
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .unwrap();

    assert_eq!(
        facts.interfaces.status,
        InterfaceExtractionStatus::Truncated
    );
    assert!(
        facts.interfaces.exports.len() <= opcore::api::test_support::MAX_INTERFACE_FACTS_PER_FILE
    );
}

#[test]
fn extracts_static_dependencies_without_turning_types_or_dynamic_imports_into_runtime_edges() {
    let facts = node::analyze(
        &source(
            "src/dependencies.ts",
            r#"
import './side-effect.js';
import type { Shape } from './shape.js';
import { type Label, value } from './mixed.js';
export type { Result } from './result.js';
export * from './runtime.js';
const lazy = import('./lazy.js');
// import './comment.js';
const text = "import './string.js'";
"#,
            Language::TypeScript,
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .unwrap();

    assert_eq!(
        facts.dependencies.status,
        DependencyExtractionStatus::Complete
    );
    assert_eq!(
        facts.dependencies.references,
        vec![
            dependency(DependencyReferenceKind::NodeRuntime, "./mixed.js"),
            dependency(DependencyReferenceKind::NodeRuntime, "./runtime.js"),
            dependency(DependencyReferenceKind::NodeRuntime, "./side-effect.js"),
            dependency(DependencyReferenceKind::NodeType, "./result.js"),
            dependency(DependencyReferenceKind::NodeType, "./shape.js"),
            dependency(DependencyReferenceKind::NodeUnsupportedDynamic, ""),
        ]
    );
}

#[test]
fn require_calls_and_typescript_import_equals_are_explicitly_unsupported() {
    let facts = node::analyze(
        &source(
            "src/loaders.cts",
            "const runtime = require('./runtime');\nimport legacy = require('./legacy');\n",
            Language::TypeScript,
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .unwrap();

    assert_eq!(
        facts.dependencies.references,
        vec![
            dependency(DependencyReferenceKind::NodeUnsupportedDynamic, ""),
            dependency(DependencyReferenceKind::NodeUnsupportedDynamic, ""),
        ]
    );
}

#[test]
fn dependency_fact_overflow_is_explicit_and_bounded() {
    let source_text = (0..=opcore::api::test_support::MAX_DEPENDENCY_FACTS_PER_FILE)
        .map(|_| "import './target';\n")
        .collect::<String>();
    let facts = node::analyze(
        &source("src/overflow.ts", &source_text, Language::TypeScript),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .unwrap();

    assert_eq!(
        facts.dependencies.status,
        DependencyExtractionStatus::Truncated
    );
    assert_eq!(
        facts.dependencies.references.len(),
        opcore::api::test_support::MAX_DEPENDENCY_FACTS_PER_FILE
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
fn parses_every_node_extension_mode() {
    let fixtures = [
        ("src/a.js", "export function a() {}", Language::JavaScript),
        (
            "src/a.jsx",
            "export const A = () => <div />;",
            Language::JavaScript,
        ),
        (
            "src/a.mjs",
            "await Promise.resolve();",
            Language::JavaScript,
        ),
        ("src/a.cjs", "return module.exports;", Language::JavaScript),
        (
            "src/a.ts",
            "export function a<T>(x: T): T { return x; }",
            Language::TypeScript,
        ),
        (
            "src/a.tsx",
            "export const A = (x: { n: number }) => <div>{x.n}</div>;",
            Language::TypeScript,
        ),
        (
            "src/a.mts",
            "export const n: number = 1;",
            Language::TypeScript,
        ),
        (
            "src/a.cts",
            "export = function value(): number { return 1; };",
            Language::TypeScript,
        ),
        (
            "src/a.d.ts",
            "export declare function a(x: string): void;",
            Language::TypeScript,
        ),
        (
            "src/a.d.mts",
            "export declare const n: number;",
            Language::TypeScript,
        ),
        (
            "src/a.d.cts",
            "export = value; declare const value: number;",
            Language::TypeScript,
        ),
    ];
    for (path, text, language) in fixtures {
        let facts = node::analyze(
            &source(path, text, language),
            &RuleLimits::default(),
            &CancelToken::new(),
        )
        .unwrap_or_else(|error| panic!("{path}: {error}"));
        assert_eq!(facts.parser, "oxc-parser", "{path}");
        assert!(
            facts
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.rule_id != "node.syntax"),
            "{path}: {:?}",
            facts.diagnostics
        );
    }
}

#[test]
fn parses_esm_constructs_in_ambiguous_node_language_modes() {
    let fixtures = [
        (
            "src/entry.js",
            "const location = import.meta.url; console.log(location);",
            Language::JavaScript,
            "javascript:unambiguous",
        ),
        (
            "src/view.jsx",
            "export const view = <div />; console.log(import.meta.url);",
            Language::JavaScript,
            "javascript:jsx",
        ),
        (
            "src/entry.ts",
            "const location: string = import.meta.url; console.log(location);",
            Language::TypeScript,
            "typescript",
        ),
        (
            "src/view.tsx",
            "export const view = <div />; console.log(import.meta.url);",
            Language::TypeScript,
            "typescript:tsx",
        ),
        (
            "src/await.js",
            "import './setup.js'; await Promise.resolve();",
            Language::JavaScript,
            "javascript:unambiguous",
        ),
        (
            "src/await.tsx",
            "import './setup.js'; await Promise.resolve();",
            Language::TypeScript,
            "typescript:tsx",
        ),
    ];

    for (path, text, language, language_mode) in fixtures {
        let facts = node::analyze(
            &source_with_mode(path, text, language, language_mode),
            &RuleLimits::default(),
            &CancelToken::new(),
        )
        .unwrap_or_else(|error| panic!("{path}: {error}"));
        assert!(
            facts
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.rule_id != "node.syntax"),
            "{path}: {:?}",
            facts.diagnostics
        );
        assert_eq!(
            facts.dependencies.status,
            DependencyExtractionStatus::Complete,
            "{path}"
        );
    }
}

#[test]
fn emits_ranged_parser_diagnostic_and_suppresses_derived_facts() {
    let facts = node::analyze(
        &source(
            "src/broken.ts",
            "export function broken( {",
            Language::TypeScript,
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .expect("syntax findings are analysis results");
    let syntax = facts
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.rule_id == "node.syntax")
        .expect("syntax diagnostic");
    assert!(syntax.range.is_some());
    assert_eq!(syntax.evidence["parser"], "oxc-parser");
    assert_eq!(
        facts.dependencies.status,
        DependencyExtractionStatus::ParserFailed
    );
    assert!(facts.dependencies.references.is_empty());
    assert_fingerprints_parser_failed(&facts);
}

#[test]
fn reports_function_metrics_for_functions_methods_and_arrows() {
    let fixture = r"
function declared(a, b, c) {
  if (a) {
    for (const item of b) {
      while (item) {
        if (c) return item;
      }
    }
  }
}
class Service {
  run(a, b, c) { return a && b ? c : a; }
}
const arrow = (a, b, c) => a || b;
";
    let limits = RuleLimits {
        max_function_lines: 4,
        max_parameters: 2,
        max_nesting: 2,
        max_cyclomatic_complexity: 2,
        ..RuleLimits::default()
    };
    let facts = node::analyze(
        &source("src/metrics.js", fixture, Language::JavaScript),
        &limits,
        &CancelToken::new(),
    )
    .expect("analysis");
    let rules = facts
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.rule_id.as_str())
        .collect::<Vec<_>>();
    assert!(rules.contains(&"complexity.max-function-lines"));
    assert!(rules.contains(&"complexity.max-parameters"));
    assert!(rules.contains(&"complexity.max-nesting"));
    assert!(rules.contains(&"complexity.max-cyclomatic-complexity"));
}

#[test]
fn cancellation_is_observed_before_parsing() {
    let cancel = CancelToken::new();
    cancel.cancel();
    let result = node::analyze(
        &source("src/a.js", "export const n = 1;", Language::JavaScript),
        &RuleLimits::default(),
        &cancel,
    );
    assert!(matches!(result, Err(AnalysisError::Cancelled)));
}

#[test]
fn callable_fingerprints_ignore_wrapper_names_comments_and_horizontal_spacing() {
    let body = javascript_assignments(16);
    let javascript = node::analyze(
        &source(
            "src/first.js",
            &format!("function first(input) {{\n{body}\nreturn value15;\n}}"),
            Language::JavaScript,
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .unwrap();
    let typescript = node::analyze(
        &source(
            "src/second.ts",
            &format!(
                "function second(input: number) {{\n{body}\nreturn  /* retained semantics */  value15;\n}}"
            ),
            Language::TypeScript,
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .unwrap();

    assert_eq!(
        javascript.callable_fingerprints.status,
        FingerprintExtractionStatus::Complete
    );
    assert_eq!(javascript.callable_fingerprints.callables.len(), 1);
    assert_eq!(
        javascript.callable_fingerprints.callables[0].digest,
        typescript.callable_fingerprints.callables[0].digest
    );
}

#[test]
fn callable_fingerprints_preserve_line_breaks_that_can_change_asi_semantics() {
    let prefix = javascript_assignments(16);
    let digest = |tail: &str| {
        node::analyze(
            &source(
                "src/asi.js",
                &format!("function value(input) {{\n{prefix}\n{tail}\n}}"),
                Language::JavaScript,
            ),
            &RuleLimits::default(),
            &CancelToken::new(),
        )
        .unwrap()
        .callable_fingerprints
        .callables[0]
            .digest
            .clone()
    };

    assert_ne!(digest("return\nvalue15;"), digest("return value15;"));
}

#[test]
fn callable_fingerprints_retain_only_maximal_non_nested_callables() {
    let statements = javascript_assignments(20).replace("value", "nested");
    let facts = node::analyze(
        &source(
            "src/nested.js",
            &format!(
                concat!(
                    "function outer(input) {{ function inner(input) {{ {} ",
                    "return nested19; }} return inner(input); }}"
                ),
                statements
            ),
            Language::JavaScript,
        ),
        &RuleLimits::default(),
        &CancelToken::new(),
    )
    .unwrap();

    assert_eq!(facts.callable_fingerprints.callables.len(), 1);
}

#[test]
fn declaration_function_types_are_not_counted_as_runtime_arrows() {
    let limits = RuleLimits {
        max_parameters: 0,
        ..RuleLimits::default()
    };
    let facts = node::analyze(
        &source(
            "src/types.d.ts",
            "export type Handler = (value: string) => void;",
            Language::TypeScript,
        ),
        &limits,
        &CancelToken::new(),
    )
    .expect("declaration analysis");
    assert!(
        facts
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.rule_id != "complexity.max-parameters")
    );
}

#[test]
fn expression_arrow_complexity_is_measured() {
    let limits = RuleLimits {
        max_cyclomatic_complexity: 1,
        ..RuleLimits::default()
    };
    let facts = node::analyze(
        &source(
            "src/arrow.js",
            "const select = value => value && (value.ok ? 1 : 0);",
            Language::JavaScript,
        ),
        &limits,
        &CancelToken::new(),
    )
    .expect("arrow analysis");
    assert!(facts.diagnostics.iter().any(|diagnostic| {
        diagnostic.rule_id == "complexity.max-cyclomatic-complexity"
            && diagnostic.evidence["actual"] == 3
    }));
}

#[test]
fn javascript_object_property_arrow_is_measured() {
    let limits = RuleLimits {
        max_parameters: 0,
        ..RuleLimits::default()
    };
    let facts = node::analyze(
        &source(
            "src/object.js",
            "const handlers = { select: (value) => value };",
            Language::JavaScript,
        ),
        &limits,
        &CancelToken::new(),
    )
    .expect("object arrow analysis");
    assert!(
        facts
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.rule_id == "complexity.max-parameters")
    );
}

#[test]
fn typescript_type_alias_arrow_is_not_a_runtime_function() {
    let limits = RuleLimits {
        max_parameters: 0,
        ..RuleLimits::default()
    };
    let facts = node::analyze(
        &source(
            "src/types.ts",
            "export type Handler = (value: string) => string;",
            Language::TypeScript,
        ),
        &limits,
        &CancelToken::new(),
    )
    .expect("type alias analysis");
    assert!(
        facts
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.rule_id != "complexity.max-parameters")
    );
}

#[test]
fn typescript_runtime_metrics_ignore_type_syntax_and_count_generic_parameters_correctly() {
    let facts = node::analyze(
        &source(
            "src/runtime.ts",
            concat!(
                "function typed(a: Map<string, number>, b: number, c: number, d: number, e: number, f: number) {",
                "type A<T> = T extends string ? 1 : 2;",
                "type B<T> = T extends string ? 1 : 2;",
                "return a; }",
            ),
            Language::TypeScript,
        ),
        &RuleLimits {
            max_parameters: 5,
            max_cyclomatic_complexity: 1,
            ..RuleLimits::default()
        },
        &CancelToken::new(),
    )
    .unwrap();
    let parameters = facts
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.rule_id == "complexity.max-parameters")
        .unwrap();
    assert_eq!(parameters.evidence["actual"], 6);
    assert!(
        facts
            .diagnostics
            .iter()
            .all(|diagnostic| { diagnostic.rule_id != "complexity.max-cyclomatic-complexity" })
    );
}

#[test]
fn trailing_parameter_comma_is_not_counted_as_an_extra_parameter() {
    let facts = node::analyze(
        &source(
            "src/exact.ts",
            "export function exact(a: string, b: string, c: string, d: string, e: string,) { return a; }",
            Language::TypeScript,
        ),
        &RuleLimits {
            max_parameters: 5,
            ..RuleLimits::default()
        },
        &CancelToken::new(),
    )
    .expect("valid TypeScript with a trailing parameter comma");

    assert!(
        facts
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.rule_id != "complexity.max-parameters")
    );
}

#[test]
fn measures_contextual_arrows_methods_with_object_return_types_and_braceless_nesting() {
    let fixture = concat!(
        "const handlers = { select: (a,b,c,d,e,f) => a };",
        "const selected = true ? null : (a,b,c,d,e,f) => a;",
        "class Service { run(a,b,c,d,e,f): { value: number } { return { value: a }; } }",
        "function nested(a,b,c) { if (a) if (b) if (c) return 1; return 0; }",
    );
    let facts = node::analyze(
        &source("src/context.ts", fixture, Language::TypeScript),
        &RuleLimits {
            max_parameters: 5,
            max_nesting: 2,
            ..RuleLimits::default()
        },
        &CancelToken::new(),
    )
    .unwrap();
    assert_eq!(
        facts
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.rule_id == "complexity.max-parameters")
            .count(),
        3
    );
    assert!(facts.diagnostics.iter().any(|diagnostic| {
        diagnostic.rule_id == "complexity.max-nesting" && diagnostic.evidence["actual"] == 3
    }));
}

#[test]
fn rejects_excessive_structure_before_recursive_parser_work() {
    let text = format!(
        "export const value = {}1{};",
        "(".repeat(300),
        ")".repeat(300)
    );
    assert!(matches!(
        node::analyze(
            &source("src/deep.ts", &text, Language::TypeScript),
            &RuleLimits::default(),
            &CancelToken::new(),
        ),
        Err(AnalysisError::Unsupported(message)) if message.contains("structural depth")
    ));
}

#[test]
fn typed_return_arrows_are_runtime_but_function_type_arrows_are_not() {
    let limits = RuleLimits {
        max_parameters: 5,
        ..RuleLimits::default()
    };
    let runtime = node::analyze(
        &source(
            "src/runtime.ts",
            "export const overloaded = (a,b,c,d,e,f): number => a;",
            Language::TypeScript,
        ),
        &limits,
        &CancelToken::new(),
    )
    .unwrap();
    assert_max_parameter_finding(&runtime);

    for fixture in [
        "export type Registry = { callback: (a,b,c,d,e,f) => void };",
        "export function register(callback: (a,b,c,d,e,f) => void): void {}",
    ] {
        let facts = node::analyze(
            &source("src/types.ts", fixture, Language::TypeScript),
            &limits,
            &CancelToken::new(),
        )
        .unwrap();
        assert!(
            facts
                .diagnostics
                .iter()
                .all(|diagnostic| { diagnostic.rule_id != "complexity.max-parameters" })
        );
    }
}

#[test]
fn object_return_type_does_not_hide_method_body_metrics() {
    let facts = analyze_typescript(
        "src/service.ts",
        concat!(
            "export class Service { run(value): { value: number } {",
            "if (value) if (value) if (value) if (value) if (value) return { value };",
            "return { value }; } }",
        ),
        &RuleLimits::default(),
    );
    assert_max_nesting_finding(&facts);
}

#[test]
fn primitive_return_types_do_not_extend_function_spans_into_later_declarations() {
    for separator in ["\n".repeat(105), "// separation\n".repeat(105)] {
        for following in [
            "export function last(): number {\n  return 1;\n}\n",
            "export class Last {}\n",
        ] {
            let fixture = format!(
                "export function first(): string {{\n  return \"ok\";\n}}\n{separator}{following}"
            );
            let facts = analyze_typescript("src/typed.ts", &fixture, &RuleLimits::default());
            assert!(
                facts
                    .diagnostics
                    .iter()
                    .all(|diagnostic| { diagnostic.rule_id != "complexity.max-function-lines" })
            );
        }
    }
}

#[test]
fn object_return_type_keeps_the_following_function_body() {
    for return_type in [
        "{ value: number }",
        "[{ value: number }]",
        "Promise<{ value: number }>",
        "number | { value: number }",
        "({ value: number })",
        "T extends { value: number } ? number : string",
        "a is { value: number }",
        "<T = {}>() => T",
    ] {
        let fixture = format!(
            "export function overloaded(a,b,c,d,e,f): {return_type} {{ return {{ value: a }}; }}"
        );
        let facts = analyze_typescript("src/object-return.ts", &fixture, &RuleLimits::default());
        assert_max_parameter_finding(&facts);
    }
}

#[test]
fn is_named_return_types_do_not_hide_function_bodies() {
    for return_type in ["is", "types.is"] {
        let fixture = format!(
            concat!(
                "type is = number; namespace types {{ export type is = number; }} ",
                "export function checked(a,b,c,d,e,f): {return_type} {{ ",
                "if (a) if (b) if (c) if (d) if (e) return 1; return 0; }}"
            ),
            return_type = return_type
        );
        let facts = analyze_typescript("src/is-return.ts", &fixture, &RuleLimits::default());
        for (rule, actual) in [
            ("complexity.max-parameters", 6),
            ("complexity.max-nesting", 5),
        ] {
            assert!(facts.diagnostics.iter().any(|diagnostic| {
                diagnostic.rule_id == rule && diagnostic.evidence["actual"] == actual
            }));
        }
    }
}

#[test]
fn is_named_predicate_types_do_not_hide_function_bodies() {
    for predicate in ["a is is", "a is types.is", "typeof is", "is | is"] {
        let fixture = format!(
            concat!(
                "type is = number; namespace types {{ export type is = number; }}\n",
                "export function first(a: unknown): {} {{ return true; }}\n",
                "{}",
                "export function next(): number {{ return 1; }}\n"
            ),
            predicate,
            "\n".repeat(105)
        );
        let facts = analyze_typescript("src/is-predicate.ts", &fixture, &RuleLimits::default());
        assert!(
            facts
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.rule_id != "complexity.max-function-lines"),
            "{predicate}"
        );
    }
}

#[test]
fn generic_function_return_types_do_not_create_runtime_arrows() {
    let facts = analyze_typescript(
        "src/generic-return.ts",
        concat!(
            "export function make(): <T = {}>(a,b,c,d,e,f) => T { ",
            "throw new Error('unused'); }"
        ),
        &RuleLimits::default(),
    );

    assert!(
        facts
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.rule_id != "complexity.max-parameters")
    );
}

#[test]
fn semicolonless_signature_does_not_capture_the_next_declaration() {
    for following in [
        "export function next(): number { return 1; }",
        "import { value } from './value'",
        "async function next() { return 1; }",
        "abstract class Next { abstract run(): void; }",
        "type Next = { value: number }",
    ] {
        let fixture = format!(
            "declare function factory(): () => void\n{}{following}\n",
            "\n".repeat(105)
        );
        let facts = analyze_typescript("src/signature.ts", &fixture, &RuleLimits::default());

        for rule in ["node.syntax", "complexity.max-function-lines"] {
            assert!(
                facts
                    .diagnostics
                    .iter()
                    .all(|diagnostic| diagnostic.rule_id != rule),
                "{following}"
            );
        }
    }
}

#[test]
fn nested_ambient_signature_stops_at_its_enclosing_declaration() {
    for declaration in ["module \"pkg\"", "namespace Package"] {
        let fixture = format!(
            concat!(
                "declare {} {{\n",
                "  export function factory(): () => void\n",
                "}}\n",
                "{}",
                "export class Next {{}}\n"
            ),
            declaration,
            "\n".repeat(105)
        );
        let facts = analyze_typescript("src/ambient.ts", &fixture, &RuleLimits::default());

        for rule in ["node.syntax", "complexity.max-function-lines"] {
            assert!(
                facts
                    .diagnostics
                    .iter()
                    .all(|diagnostic| diagnostic.rule_id != rule),
                "{declaration}"
            );
        }
    }
}

#[test]
fn type_arrows_after_ambient_member_semicolons_are_not_runtime_callables() {
    for fixture in [
        concat!(
            "declare namespace API { const value: number; ",
            "export function make(): (a,b,c,d,e,f) => void }"
        ),
        "declare class API { value: number; make(): (a,b,c,d,e,f) => void }",
        "interface API { value: number; make(): (a,b,c,d,e,f) => void }",
        "type API = { value: number; make: (a,b,c,d,e,f) => void }",
    ] {
        let facts = analyze_typescript("src/ambient-members.ts", fixture, &RuleLimits::default());
        assert!(
            facts
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.rule_id != "complexity.max-parameters"),
            "{fixture}"
        );
    }

    let runtime = analyze_typescript(
        "src/runtime-class.ts",
        "class API { value = 1; make = (a,b,c,d,e,f) => a }",
        &RuleLimits::default(),
    );
    assert_max_parameter_finding(&runtime);

    let contextual_keyword = analyze_typescript(
        "src/runtime-parameter.ts",
        concat!(
            "export function outer(type: string) { ",
            "const nested = (a,b,c,d,e,f) => a; return nested; }"
        ),
        &RuleLimits::default(),
    );
    assert_max_parameter_finding(&contextual_keyword);
}

#[test]
fn parser_distinguishes_type_arrows_in_other_typescript_positions() {
    for fixture in [
        "const handler: (a,b,c,d,e,f) => void = () => {};",
        "class C { handler: (a,b,c,d,e,f) => void }",
        "declare function use<T>(): void; use<(a,b,c,d,e,f) => void>();",
        concat!(
            "export const config: { handler: (a,b,c,d,e,f) => void } = ",
            "{ handler: () => {} };"
        ),
    ] {
        let facts = analyze_typescript("src/type-position.ts", fixture, &RuleLimits::default());
        assert!(
            facts
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.rule_id != "complexity.max-parameters"),
            "{fixture}"
        );
    }

    let bases = (0..=300)
        .map(|index| format!("A{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let long_interface = format!(
        "interface API extends {bases} {{ value: number; callback: (a,b,c,d,e,f) => void }}"
    );
    let facts = analyze_typescript(
        "src/long-interface.ts",
        &long_interface,
        &RuleLimits::default(),
    );
    assert!(
        facts
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.rule_id != "complexity.max-parameters")
    );
}

#[test]
fn semicolonless_type_declarations_do_not_hide_runtime_arrows() {
    for fixture in [
        concat!(
            "type T = number\nexport function outer() { ",
            "const run = (a,b,c,d,e,f) => a; return run; }"
        ),
        concat!(
            "class C { declare value: string\nmethod() { ",
            "const run = (a,b,c,d,e,f) => a; return run; } }"
        ),
    ] {
        let facts =
            analyze_typescript("src/runtime-after-type.ts", fixture, &RuleLimits::default());
        assert_max_parameter_finding(&facts);
    }
}

#[test]
fn parser_spans_bind_runtime_arrow_parameters_through_complex_return_types() {
    for return_type in [
        "(() => number)",
        "(<T = {}>() => T)",
        "{ value: number; other: string }",
        "T extends U ? (() => number) : ((x: string) => string)",
    ] {
        let fixture = format!("export const run = (a,b,c,d,e,f): {return_type} => a;");
        let facts = analyze_typescript("src/typed-arrow.ts", &fixture, &RuleLimits::default());
        assert_max_parameter_finding(&facts);
    }

    let return_type = (0..=300)
        .map(|index| format!("A{index}"))
        .collect::<Vec<_>>()
        .join(" &\n");
    let fixture = format!("export const run = (a,b,c,d,e,f):\n{return_type} => a;");
    let facts = analyze_typescript("src/long-arrow.ts", &fixture, &RuleLimits::default());
    assert_max_parameter_finding(&facts);
}

#[test]
fn parser_spans_bound_concise_arrow_bodies() {
    let fixture = format!(
        "export const compare = (value) => value < 3;\n{}export function last() {{ return 1; }}",
        "// separate declaration\n".repeat(105)
    );
    let facts = analyze_typescript("src/comparison-arrow.ts", &fixture, &RuleLimits::default());
    assert!(
        facts
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.rule_id != "complexity.max-function-lines")
    );
}

#[test]
fn parser_spans_bind_method_parameters_through_long_return_types() {
    let return_type = (0..=100)
        .map(|index| format!("A{index}"))
        .collect::<Vec<_>>()
        .join(" &\n");
    let fixture =
        format!("class Service {{ method(a,b,c,d,e,f):\n{return_type} {{ return a; }} }}");
    let facts = analyze_typescript("src/long-method.ts", &fixture, &RuleLimits::default());
    assert_max_parameter_finding(&facts);
}

#[test]
fn parser_counts_contextual_unparenthesized_arrow_parameters() {
    for parameter in ["type", "async", "of"] {
        let fixture = format!(
            "export const run = {parameter} => {{ if ({parameter}) if ({parameter}) if ({parameter}) if ({parameter}) if ({parameter}) return 1; }};"
        );
        let facts = analyze_typescript(
            "src/contextual-parameter.ts",
            &fixture,
            &RuleLimits::default(),
        );
        assert_max_nesting_finding(&facts);
    }
}

#[test]
fn parser_handles_object_literal_accessors_as_methods() {
    for fixture in [
        "export const value = { get current() { if (1) if (1) if (1) if (1) if (1) return 1; } };",
        "export const value = { set current(input) { if (input) if (input) if (input) if (input) if (input) this.saved = input; } };",
    ] {
        let facts = analyze_typescript("src/accessor.ts", fixture, &RuleLimits::default());
        assert_max_nesting_finding(&facts);
    }
}

#[test]
fn parser_counts_parameters_with_comparisons_in_defaults() {
    for fixture in [
        "export const run = (a = 1 < 2,b,c,d,e,f) => a;",
        "export function run(a = 1 < 2,b,c,d,e,f) { return a; }",
        "class Service { run(a = 1 < 2,b,c,d,e,f) { return a; } }",
    ] {
        let facts =
            analyze_typescript("src/comparison-default.ts", fixture, &RuleLimits::default());
        assert_max_parameter_finding(&facts);
    }
}

#[test]
fn typed_function_metric_range_ends_at_its_own_body() {
    let fixture = concat!(
        "export function first(a,b,c,d,e,f): string {\n",
        "  return String(a);\n",
        "}\n",
        "\n\n",
        "export function last(): number {\n",
        "  return 1;\n",
        "}\n",
    );
    let facts = analyze_typescript("src/typed-range.ts", fixture, &RuleLimits::default());
    let diagnostic = facts
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.rule_id == "complexity.max-parameters")
        .unwrap();
    let range = diagnostic.range.unwrap();

    assert_eq!(range.start.line, 1);
    assert_eq!(range.end.line, 3);
}

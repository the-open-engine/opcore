use super::{extract_sources, ExtractionOptions};
use crate::protocol::{
    GraphExtractionDiagnosticCategory as Category, GraphExtractionDiagnosticSeverity as Severity,
    GraphFactNode,
};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tempfile::TempDir;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn wave1_fixture_extracts_contract_facts() -> TestResult {
    let fixture_root = wave1_fixture_root()?;
    let expected: Value = serde_json::from_str(&fs::read_to_string(
        fixture_root.join("wave1.expected.json"),
    )?)?;

    let result = extract_sources(ExtractionOptions::new(&fixture_root));

    assert!(
        !result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == Severity::Error),
        "{:?}",
        result.diagnostics
    );
    assert_eq!(
        sorted(result.nodes.iter().map(|node| node.id.clone()).collect()),
        value_strings(&expected, "nodeIds")?
    );
    assert_eq!(
        sorted(result.metadata.node_kinds),
        value_strings(&expected, "nodeKinds")?
    );
    assert_eq!(
        sorted(result.metadata.edge_kinds),
        value_strings(&expected, "edgeKinds")?
    );
    assert_eq!(
        edge_triples(&result.edges),
        value_triples(&expected, "edgeTriples")?
    );
    assert_eq!(
        node_attributes(&result.nodes),
        value_object(&expected, "nodeAttributes")?
    );
    assert_eq!(
        file_exports(&result.nodes),
        value_object(&expected, "fileExports")?
    );
    Ok(())
}

#[test]
fn export_metadata_marks_supported_ts_js_declarations() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write_export_metadata_fixture(&repo)?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));

    assert!(
        !result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == Severity::Error),
        "{:?}",
        result.diagnostics
    );
    assert_exported_symbol_attributes(&result.nodes)?;
    assert_non_exported_symbol_attributes(&result.nodes)?;
    assert_index_file_export_metadata(&result.nodes)?;
    Ok(())
}

#[test]
fn import_backed_barrel_exports_are_unsupported_reexport_metadata() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(
        &repo,
        "src/source.ts",
        "export default function inner() { return 1; }\nexport const named = 1;",
    )?;
    write(
        &repo,
        "src/barrel.ts",
        "import inner, { named } from './source';\nexport { named };\nexport default inner;",
    )?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));
    let exports = required_exports(&result.nodes, "file:src/barrel.ts")?;

    for expected in [
        json!({"kind": "named", "local": "named", "exported": "named", "source": "./source", "imported": "named", "supportedSymbol": false}),
        json!({"kind": "default", "local": "inner", "exported": "default", "source": "./source", "imported": "default", "supportedSymbol": false}),
    ] {
        assert!(exports.contains(&expected), "{expected}");
    }
    assert_missing_node(&result.nodes, "variable:src/barrel.ts#named")?;
    assert_missing_node(&result.nodes, "function:src/barrel.ts#inner")?;
    Ok(())
}

#[test]
fn unresolved_local_exports_are_unsupported_file_metadata() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(
        &repo,
        "src/index.ts",
        "export { missing as renamed };\nfunction internal(){return 1;}\n",
    )?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));
    let exports = required_exports(&result.nodes, "file:src/index.ts")?;

    assert!(exports.contains(&json!({
        "kind": "named",
        "local": "missing",
        "exported": "renamed",
        "source": null,
        "supportedSymbol": false
    })));
    assert_eq!(
        required_attributes(&result.nodes, "function:src/index.ts#internal")?,
        json!({"exported": false})
    );
    assert_missing_node(&result.nodes, "function:src/index.ts#missing")?;
    Ok(())
}

#[test]
fn nested_local_exports_are_unsupported_file_metadata() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(
        &repo,
        "src/index.ts",
        "export { laterNested as exportedLaterNested };\nfunction container(){ function laterNested(){ return 1; } return laterNested(); }\n",
    )?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));
    let exports = required_exports(&result.nodes, "file:src/index.ts")?;

    assert!(exports.contains(&json!({
        "kind": "named",
        "local": "laterNested",
        "exported": "exportedLaterNested",
        "source": null,
        "supportedSymbol": false
    })));
    assert_eq!(
        required_attributes(&result.nodes, "function:src/index.ts#laterNested")?,
        json!({"exported": false})
    );
    Ok(())
}

fn write_export_metadata_fixture(repo: &TempDir) -> TestResult {
    write_export_metadata_index_fixture(repo)?;
    write_export_metadata_supporting_modules(repo)?;
    write_export_metadata_default_modules(repo)?;
    write_export_metadata_jsx_modules(repo)?;
    Ok(())
}

fn write_export_metadata_index_fixture(repo: &TempDir) -> TestResult {
    write(
        repo,
        "src/index.ts",
        r#"
            export interface Renderable { render(): string; }
            export type Payload = { label: string };
            export class ExportedClass implements Renderable { render() { return "ok"; } }
            class InternalClass {}
            export function exportedFunction() { return new ExportedClass(); }
            function internalFunction() { return new InternalClass(); }
            export const exportedValue = 1;
            const internalValue = 2;
            export const exportedArrow = () => internalFunction();
            const internalArrow = () => exportedFunction();
            export function exportedWithNested() {
                function nestedLocal() { return 1; }
                return nestedLocal();
            }
            export { laterNested as exportedLaterNested };
            function container() {
                function laterNested() { return 1; }
                return laterNested();
            }
            const aliasTarget = 3;
            export { aliasTarget as renamedAlias };
            export { externalThing as renamedExternal } from "./external";
            export { default as externalDefault } from "./defaulted";
            export * from "./barrel";
            export * as namespaceExport from "./namespace";
            const defaultValue = exportedValue;
            export default defaultValue;
        "#,
    )?;
    Ok(())
}

fn write_export_metadata_supporting_modules(repo: &TempDir) -> TestResult {
    write(repo, "src/external.ts", "export const externalThing = 1;")?;
    write(
        repo,
        "src/defaulted.ts",
        "export default function defaulted() { return 1; }",
    )?;
    write(repo, "src/barrel.ts", "export const barrelValue = 1;")?;
    write(repo, "src/namespace.ts", "export const namespaced = 1;")?;
    Ok(())
}

fn write_export_metadata_default_modules(repo: &TempDir) -> TestResult {
    write(
        repo,
        "src/default-function.ts",
        "export default function defaultFunction() { return 1; }",
    )?;
    write(
        repo,
        "src/default-class.ts",
        "export default class DefaultClass {}",
    )?;
    write(
        repo,
        "src/default-class-with-method.ts",
        r#"
            export default class DefaultClassWithMethod {
                render() { return "ok"; }
            }
        "#,
    )?;
    write(
        repo,
        "src/default-interface.ts",
        "export default interface DefaultInterface {}",
    )?;
    Ok(())
}

fn write_export_metadata_jsx_modules(repo: &TempDir) -> TestResult {
    write(
        repo,
        "src/js-cases.js",
        r#"
            export function jsFunction() { return jsValue; }
            export const jsValue = 1;
            const jsInternal = 2;
        "#,
    )?;
    write(
        repo,
        "src/view.tsx",
        r#"
            export function View() { return <div />; }
            export const TsxArrow = () => <span />;
        "#,
    )?;
    write(
        repo,
        "src/widget.jsx",
        r#"
            export default function Widget() { return <div />; }
            export const WidgetHelper = () => <Widget />;
        "#,
    )?;
    Ok(())
}

fn assert_exported_symbol_attributes(nodes: &[GraphFactNode]) -> TestResult {
    for (id, expected) in [
        (
            "function:src/index.ts#exportedFunction",
            json!({"exported": true, "exportKind": "named", "exportName": "exportedFunction"}),
        ),
        (
            "class:src/index.ts#ExportedClass",
            json!({"exported": true, "exportKind": "named", "exportName": "ExportedClass"}),
        ),
        (
            "type:src/index.ts#Renderable",
            json!({"exported": true, "exportKind": "named", "exportName": "Renderable"}),
        ),
        (
            "type:src/index.ts#Payload",
            json!({"exported": true, "exportKind": "named", "exportName": "Payload"}),
        ),
        (
            "variable:src/index.ts#exportedValue",
            json!({"exported": true, "exportKind": "named", "exportName": "exportedValue"}),
        ),
        (
            "function:src/index.ts#exportedArrow",
            json!({"exported": true, "exportKind": "named", "exportName": "exportedArrow"}),
        ),
        (
            "function:src/index.ts#exportedWithNested",
            json!({"exported": true, "exportKind": "named", "exportName": "exportedWithNested"}),
        ),
        (
            "variable:src/index.ts#aliasTarget",
            json!({"exported": true, "exportKind": "named", "exportName": "renamedAlias"}),
        ),
        (
            "function:src/default-function.ts#defaultFunction",
            json!({"exported": true, "exportKind": "default", "exportName": "default"}),
        ),
        (
            "class:src/default-class.ts#DefaultClass",
            json!({"exported": true, "exportKind": "default", "exportName": "default"}),
        ),
        (
            "class:src/default-class-with-method.ts#DefaultClassWithMethod",
            json!({"exported": true, "exportKind": "default", "exportName": "default"}),
        ),
        (
            "type:src/default-interface.ts#DefaultInterface",
            json!({"exported": true, "exportKind": "default", "exportName": "default"}),
        ),
        (
            "function:src/js-cases.js#jsFunction",
            json!({"exported": true, "exportKind": "named", "exportName": "jsFunction"}),
        ),
        (
            "variable:src/js-cases.js#jsValue",
            json!({"exported": true, "exportKind": "named", "exportName": "jsValue"}),
        ),
        (
            "function:src/view.tsx#View",
            json!({"exported": true, "exportKind": "named", "exportName": "View"}),
        ),
        (
            "function:src/view.tsx#TsxArrow",
            json!({"exported": true, "exportKind": "named", "exportName": "TsxArrow"}),
        ),
        (
            "function:src/widget.jsx#Widget",
            json!({"exported": true, "exportKind": "default", "exportName": "default"}),
        ),
        (
            "function:src/widget.jsx#WidgetHelper",
            json!({"exported": true, "exportKind": "named", "exportName": "WidgetHelper"}),
        ),
    ] {
        assert_eq!(required_attributes(nodes, id)?, expected, "{id}");
    }
    Ok(())
}

fn assert_non_exported_symbol_attributes(nodes: &[GraphFactNode]) -> TestResult {
    for id in [
        "class:src/index.ts#InternalClass",
        "function:src/index.ts#internalFunction",
        "variable:src/index.ts#internalValue",
        "function:src/index.ts#internalArrow",
        "function:src/index.ts#container",
        "function:src/index.ts#nestedLocal",
        "function:src/index.ts#laterNested",
        "variable:src/js-cases.js#jsInternal",
    ] {
        assert_eq!(
            required_attributes(nodes, id)?,
            json!({"exported": false}),
            "{id}"
        );
    }
    assert_missing_node(nodes, "function:src/default-class-with-method.ts#default")?;
    Ok(())
}

fn assert_index_file_export_metadata(nodes: &[GraphFactNode]) -> TestResult {
    let index_exports = required_exports(nodes, "file:src/index.ts")?;
    for expected in [
        json!({"kind": "named", "local": "externalThing", "exported": "renamedExternal", "source": "./external", "imported": "externalThing", "supportedSymbol": true}),
        json!({"kind": "named", "local": "default", "exported": "externalDefault", "source": "./defaulted", "imported": "default", "supportedSymbol": true}),
        json!({"kind": "all", "exported": "*", "source": "./barrel", "supportedSymbol": false}),
        json!({"kind": "namespace", "exported": "namespaceExport", "source": "./namespace", "supportedSymbol": false}),
        json!({"kind": "default", "local": "defaultValue", "exported": "default", "source": null, "supportedSymbol": true}),
        json!({"kind": "named", "local": "laterNested", "exported": "exportedLaterNested", "source": null, "supportedSymbol": false}),
    ] {
        assert!(index_exports.contains(&expected), "{expected}");
    }
    Ok(())
}

#[test]
fn tsconfig_path_aliases_resolve_to_repo_relative_files() -> TestResult {
    let result = extract_sources(ExtractionOptions::new(wave1_fixture_root()?));
    let triples = edge_triples(&result.edges);

    assert!(triples.contains(&vec![
        "IMPORTS_FROM".to_string(),
        "file:src/__tests__/greeting.test.ts".to_string(),
        "file:src/math.js".to_string()
    ]));
    assert!(triples.contains(&vec![
        "IMPORTS_FROM".to_string(),
        "file:src/legacy-widget.jsx".to_string(),
        "file:src/components/GreetingCard.tsx".to_string()
    ]));
    Ok(())
}

#[test]
fn unimported_cross_file_symbols_do_not_create_edges() -> TestResult {
    let repo = temp_repo()?;
    write(
        &repo,
        "tsconfig.json",
        r#"{"compilerOptions":{"baseUrl":"."}}"#,
    )?;
    write(
        &repo,
        "src/a.ts",
        r#"
            export function caller() { return target(); }
            export class Child extends Base implements Shape {}
        "#,
    )?;
    write(
        &repo,
        "src/b.ts",
        r#"
            export function target() { return 1; }
            export class Base {}
            export interface Shape {}
        "#,
    )?;
    write(
        &repo,
        "src/c.ts",
        r#"
            export function localCaller() { return sameName(); }
            export function sameName() { return 1; }
        "#,
    )?;
    write(
        &repo,
        "src/d.ts",
        "export function sameName() { return 2; }",
    )?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));
    let triples = edge_triples(&result.edges);

    assert!(!result
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error));
    assert!(!triples.contains(&vec![
        "CALLS".to_string(),
        "function:src/a.ts#caller".to_string(),
        "function:src/b.ts#target".to_string()
    ]));
    assert!(!triples.contains(&vec![
        "INHERITS".to_string(),
        "class:src/a.ts#Child".to_string(),
        "class:src/b.ts#Base".to_string()
    ]));
    assert!(!triples.contains(&vec![
        "IMPLEMENTS".to_string(),
        "class:src/a.ts#Child".to_string(),
        "type:src/b.ts#Shape".to_string()
    ]));
    assert!(triples.contains(&vec![
        "CALLS".to_string(),
        "function:src/c.ts#localCaller".to_string(),
        "function:src/c.ts#sameName".to_string()
    ]));
    Ok(())
}

#[test]
fn default_imports_resolve_to_default_exported_symbols() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(
        &repo,
        "src/default-function.ts",
        "export default function usedDefault() { return 1; }",
    )?;
    write(
        &repo,
        "src/default-value.ts",
        "const usedValue = () => 1; export default usedValue;",
    )?;
    write(
        &repo,
        "src/index.ts",
        r#"
            import usedDefault from "./default-function";
            import usedValue from "./default-value";
            export function run() {
                return usedDefault() + usedValue();
            }
        "#,
    )?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));
    let triples = edge_triples(&result.edges);

    assert!(!result
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error));
    assert!(triples.contains(&vec![
        "CALLS".to_string(),
        "function:src/index.ts#run".to_string(),
        "function:src/default-function.ts#usedDefault".to_string()
    ]));
    assert!(triples.contains(&vec![
        "CALLS".to_string(),
        "function:src/index.ts#run".to_string(),
        "function:src/default-value.ts#usedValue".to_string()
    ]));
    Ok(())
}

#[test]
fn named_export_alias_imports_resolve_to_local_exported_symbols() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(
        &repo,
        "src/dep.ts",
        "function localName() { return 1; }\nexport { localName as publicName };",
    )?;
    write(
        &repo,
        "src/index.ts",
        r#"
            import { publicName } from "./dep";
            export function run() {
                return publicName();
            }
        "#,
    )?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));
    let triples = edge_triples(&result.edges);

    assert!(!result
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error));
    assert!(triples.contains(&vec![
        "CALLS".to_string(),
        "function:src/index.ts#run".to_string(),
        "function:src/dep.ts#localName".to_string()
    ]));
    Ok(())
}

#[test]
fn source_re_export_alias_imports_resolve_to_source_exported_symbols() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(
        &repo,
        "src/source.ts",
        "export function add() { return 1; }",
    )?;
    write(
        &repo,
        "src/barrel.ts",
        "export { add as addFromBarrel } from './source';",
    )?;
    write(
        &repo,
        "src/index.ts",
        r#"
            import { addFromBarrel } from "./barrel";
            export function run() {
                return addFromBarrel();
            }
        "#,
    )?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));
    let triples = edge_triples(&result.edges);
    let exports = required_exports(&result.nodes, "file:src/barrel.ts")?;

    assert!(
        !result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == Severity::Error),
        "{:?}",
        result.diagnostics
    );
    assert!(triples.contains(&vec![
        "CALLS".to_string(),
        "function:src/index.ts#run".to_string(),
        "function:src/source.ts#add".to_string()
    ]));
    assert!(exports.contains(&json!({
        "kind": "named",
        "local": "add",
        "exported": "addFromBarrel",
        "source": "./source",
        "imported": "add",
        "supportedSymbol": true
    })));
    Ok(())
}

#[test]
fn parse_errors_are_typed_and_block_empty_success() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(&repo, "src/broken.ts", "export function broken(")?;
    assert_error_category(
        extract_sources(ExtractionOptions::new(repo.path())),
        Category::ParseError,
    );
    Ok(())
}

#[test]
fn missing_parser_errors_are_typed_and_block_empty_success() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(&repo, "src/a.ts", "export function a() { return 1; }")?;
    let mut options = ExtractionOptions::new(repo.path());
    options.force_missing_parser = true;
    assert_error_category(extract_sources(options), Category::MissingParser);
    Ok(())
}

#[test]
fn malformed_tsconfig_errors_are_typed_and_block_empty_success() -> TestResult {
    let repo = temp_repo()?;
    let malformed_json = char::from(123).to_string();
    write(&repo, "tsconfig.json", &malformed_json)?;
    write(&repo, "src/a.ts", "export function a() { return 1; }")?;
    assert_error_category(
        extract_sources(ExtractionOptions::new(repo.path())),
        Category::MalformedTsconfig,
    );
    Ok(())
}

#[test]
fn malformed_tsconfig_paths_are_typed_and_block_empty_success() -> TestResult {
    let repo = temp_repo()?;
    write(
        &repo,
        "tsconfig.json",
        r#"{"compilerOptions":{"baseUrl":".","paths":{"@bad/*":"src/*"}}}"#,
    )?;
    write(
        &repo,
        "src/a.ts",
        "import { b } from '@bad/b'; export function a() { return b(); }",
    )?;
    write(&repo, "src/b.ts", "export function b() { return 1; }")?;
    assert_error_category(
        extract_sources(ExtractionOptions::new(repo.path())),
        Category::MalformedTsconfig,
    );
    Ok(())
}

#[test]
fn max_file_errors_are_typed_and_block_empty_success() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(&repo, "src/a.ts", "export function a() { return 1; }")?;
    let mut options = ExtractionOptions::new(repo.path());
    options.max_files = 0;
    assert_error_category(extract_sources(options), Category::MaxFilesExceeded);
    Ok(())
}

#[test]
fn max_depth_errors_are_typed_and_block_empty_success() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(&repo, "src/deep/a.ts", "export function a() { return 1; }")?;
    let mut options = ExtractionOptions::new(repo.path());
    options.max_depth = 1;
    assert_error_category(extract_sources(options), Category::MaxDepthExceeded);
    Ok(())
}

#[test]
fn path_traversal_errors_are_typed_and_block_empty_success() -> TestResult {
    let repo = temp_repo()?;
    write(
        &repo,
        "tsconfig.json",
        r#"{"compilerOptions":{"baseUrl":".","paths":{"@outside/*":["../outside/*"]}}}"#,
    )?;
    write(
        &repo,
        "src/a.ts",
        "import { out } from '@outside/out'; export function a() { return out(); }",
    )?;
    assert_error_category(
        extract_sources(ExtractionOptions::new(repo.path())),
        Category::PathTraversal,
    );
    Ok(())
}

#[test]
fn unsupported_and_missing_tsconfig_are_typed_warnings() -> TestResult {
    let repo = temp_repo()?;
    write(&repo, "src/a.ts", "export function a() { return 1; }")?;
    write(&repo, "src/tool.rs", "fn main() {}")?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));

    assert!(result
        .diagnostics
        .iter()
        .any(
            |diagnostic| diagnostic.category == Category::MissingTsconfig
                && diagnostic.severity == Severity::Warning
        ));
    assert!(result
        .diagnostics
        .iter()
        .any(
            |diagnostic| diagnostic.category == Category::UnsupportedLanguage
                && diagnostic.severity == Severity::Warning
        ));
    assert!(!result
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error));
    assert!(!result.nodes.is_empty());
    Ok(())
}

fn assert_error_category(result: super::ExtractionResult, category: Category) {
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.category == category
                && diagnostic.severity == Severity::Error),
        "{:?}",
        result.diagnostics
    );
    assert!(result.nodes.is_empty());
    assert!(result.edges.is_empty());
}

fn wave1_fixture_root() -> Result<PathBuf, std::io::Error> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/fixtures/source-extraction/wave1")
        .canonicalize()
}

fn temp_repo() -> Result<TempDir, std::io::Error> {
    tempfile::tempdir()
}

fn repo_with_tsconfig() -> Result<TempDir, std::io::Error> {
    let repo = temp_repo()?;
    write(
        &repo,
        "tsconfig.json",
        r#"{"compilerOptions":{"baseUrl":"."}}"#,
    )?;
    Ok(repo)
}

fn write(repo: &TempDir, path: &str, contents: &str) -> Result<(), std::io::Error> {
    let path = repo.path().join(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)
}

fn edge_triples(edges: &[crate::protocol::GraphFactEdge]) -> Vec<Vec<String>> {
    sorted(
        edges
            .iter()
            .map(|edge| vec![edge.kind.clone(), edge.from.clone(), edge.to.clone()])
            .collect(),
    )
}

fn value_strings(value: &Value, key: &str) -> Result<Vec<String>, std::io::Error> {
    let entries = value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| std::io::Error::other(format!("missing string array {key}")))?;
    entries
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .map(ToString::to_string)
                .ok_or_else(|| std::io::Error::other(format!("non-string entry in {key}")))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(sorted)
}

fn value_triples(value: &Value, key: &str) -> Result<Vec<Vec<String>>, std::io::Error> {
    let entries = value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| std::io::Error::other(format!("missing triple array {key}")))?;
    entries
        .iter()
        .map(|entry| {
            let parts = entry
                .as_array()
                .ok_or_else(|| std::io::Error::other(format!("non-array triple in {key}")))?;
            parts
                .iter()
                .map(|part| {
                    part.as_str().map(ToString::to_string).ok_or_else(|| {
                        std::io::Error::other(format!("non-string triple part in {key}"))
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()
        .map(sorted)
}

fn value_object(value: &Value, key: &str) -> Result<Value, std::io::Error> {
    value
        .get(key)
        .cloned()
        .ok_or_else(|| std::io::Error::other(format!("missing object {key}")))
}

fn node_attributes(nodes: &[GraphFactNode]) -> Value {
    let mut attributes = serde_json::Map::new();
    for node in nodes {
        if node.kind == "File" {
            continue;
        }
        attributes.insert(
            node.id.clone(),
            node.attributes.clone().unwrap_or_else(|| json!({})),
        );
    }
    Value::Object(attributes)
}

fn file_exports(nodes: &[GraphFactNode]) -> Value {
    let mut exports_by_file = serde_json::Map::new();
    for node in nodes {
        if node.kind != "File" {
            continue;
        }
        if let Some(exports) = node
            .attributes
            .as_ref()
            .and_then(|attributes| attributes.get("exports"))
        {
            exports_by_file.insert(node.id.clone(), exports.clone());
        }
    }
    Value::Object(exports_by_file)
}

fn required_attributes(nodes: &[GraphFactNode], id: &str) -> Result<Value, std::io::Error> {
    let node = nodes
        .iter()
        .find(|node| node.id == id)
        .ok_or_else(|| std::io::Error::other(format!("missing node {id}")))?;
    node.attributes
        .clone()
        .ok_or_else(|| std::io::Error::other(format!("missing attributes for {id}")))
}

fn required_exports(nodes: &[GraphFactNode], id: &str) -> Result<Vec<Value>, std::io::Error> {
    let node = nodes
        .iter()
        .find(|node| node.id == id)
        .ok_or_else(|| std::io::Error::other(format!("missing node {id}")))?;
    node.attributes
        .as_ref()
        .and_then(|attributes| attributes.get("exports"))
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| std::io::Error::other(format!("missing exports for {id}")))
}

fn assert_missing_node(nodes: &[GraphFactNode], id: &str) -> Result<(), std::io::Error> {
    if nodes.iter().any(|node| node.id == id) {
        Err(std::io::Error::other(format!("unexpected node {id}")))
    } else {
        Ok(())
    }
}

fn sorted<T: Ord>(mut values: Vec<T>) -> Vec<T> {
    values.sort();
    values
}

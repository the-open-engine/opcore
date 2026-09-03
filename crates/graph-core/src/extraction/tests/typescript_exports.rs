use super::support::*;
use crate::extraction::{extract_sources, ExtractionOptions};
use crate::protocol::{GraphExtractionDiagnosticSeverity as Severity, GraphFactNode};
use serde_json::{json, Value};
use std::fs;
use tempfile::TempDir;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[cfg(test)]
pub(super) struct TypeScriptExportTests;

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
        json!({
            "kind": "named",
            "local": "named",
            "exported": "named",
            "source": "./source",
            "imported": "named",
            "supportedSymbol": false
        }),
        json!({
            "kind": "default",
            "local": "inner",
            "exported": "default",
            "source": "./source",
            "imported": "default",
            "supportedSymbol": false
        }),
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
        concat!(
            "export { laterNested as exportedLaterNested };\n",
            "function container(){ function laterNested(){ return 1; } return laterNested(); }\n",
        ),
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
        json!({
            "kind": "named",
            "local": "externalThing",
            "exported": "renamedExternal",
            "source": "./external",
            "imported": "externalThing",
            "supportedSymbol": true
        }),
        json!({
            "kind": "named",
            "local": "default",
            "exported": "externalDefault",
            "source": "./defaulted",
            "imported": "default",
            "supportedSymbol": true
        }),
        json!({"kind": "all", "exported": "*", "source": "./barrel", "supportedSymbol": false}),
        json!({"kind": "namespace", "exported": "namespaceExport", "source": "./namespace", "supportedSymbol": false}),
        json!({
            "kind": "default",
            "local": "defaultValue",
            "exported": "default",
            "source": null,
            "supportedSymbol": true
        }),
        json!({
            "kind": "named",
            "local": "laterNested",
            "exported": "exportedLaterNested",
            "source": null,
            "supportedSymbol": false
        }),
    ] {
        assert!(index_exports.contains(&expected), "{expected}");
    }
    Ok(())
}

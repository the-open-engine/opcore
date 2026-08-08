use super::support::*;
use crate::extraction::{extract_sources, ExtractionOptions};
use crate::protocol::GraphExtractionDiagnosticSeverity as Severity;
use serde_json::json;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[cfg(test)]
pub(super) struct TypeScriptResolutionTests;

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
fn script_test_imports_emit_file_level_tested_by_evidence() -> TestResult {
    let repo = temp_repo()?;
    write(
        &repo,
        "tsconfig.json",
        r#"{"compilerOptions":{"baseUrl":".","paths":{"@example/pkg":["src/index.ts"]}}}"#,
    )?;
    write(
        &repo,
        "src/index.ts",
        "export { publicValue } from './value.js';",
    )?;
    write(&repo, "src/value.ts", "export const publicValue = 1;")?;
    write(
        &repo,
        "tests/package-contract.test.ts",
        "import { publicValue } from '@example/pkg'; test('public value', () => publicValue);",
    )?;
    write(
        &repo,
        "src/consumer.ts",
        "import { publicValue } from '@example/pkg'; export const consumed = publicValue;",
    )?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));
    let triples = edge_triples(&result.edges);

    assert!(triples.contains(&vec![
        "TESTED_BY".to_string(),
        "file:src/index.ts".to_string(),
        "file:tests/package-contract.test.ts".to_string()
    ]));
    assert!(!triples.contains(&vec![
        "TESTED_BY".to_string(),
        "file:src/index.ts".to_string(),
        "file:src/consumer.ts".to_string()
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

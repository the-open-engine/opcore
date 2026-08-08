use super::support::*;
use crate::extraction::{
    discover_sources_for_options, extract_sources, DiscoveryResult, ExtractionOptions,
    ExtractionResult,
};
use crate::protocol::{
    GraphExtractionDiagnosticCategory as Category, GraphExtractionDiagnosticSeverity as Severity,
};

#[cfg(test)]
pub(super) struct RustTests;
use serde_json::Value;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn rust_sources_are_discovered_and_extracted() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write_rust_graph_fixture(&repo)?;

    let discovery = discover_sources_for_options(&ExtractionOptions::new(repo.path()));
    let result = extract_sources(ExtractionOptions::new(repo.path()));

    assert_rust_discovery_sources(&discovery);
    assert_rust_extraction_nodes(&result);
    assert_rust_extraction_edges(&result);
    assert_rust_extraction_attributes(&result)?;
    Ok(())
}

fn assert_rust_discovery_sources(discovery: &DiscoveryResult) {
    let sources = discovery
        .sources
        .iter()
        .map(|source| (source.relative_path.as_str(), source.language.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        sources,
        vec![
            ("src/helpers.rs", "rust"),
            ("src/lib.rs", "rust"),
            ("src/user.rs", "rust")
        ]
    );
    assert!(!discovery
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.category == Category::UnsupportedLanguage));
}

fn assert_rust_extraction_nodes(result: &ExtractionResult) {
    assert!(
        !result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == Severity::Error),
        "{:?}",
        result.diagnostics
    );
    let node_ids = sorted(result.nodes.iter().map(|node| node.id.clone()).collect());
    for id in [
        "file:src/lib.rs",
        "module:src/lib.rs#crate",
        "module:src/user.rs#user",
        "module:src/user.rs#user.tests",
        "struct:src/lib.rs#Widget",
        "enum:src/lib.rs#Mode",
        "trait:src/lib.rs#Service",
        "impl:src/lib.rs#impl Service for Widget",
        "method:src/lib.rs#Widget::handle",
        "type:src/lib.rs#Alias",
        "const:src/lib.rs#LIMIT",
        "static:src/lib.rs#NAME",
        "macro:src/lib.rs#trace",
        "function:src/helpers.rs#helpers::assist",
        "function:src/user.rs#user::run",
        "test:src/user.rs#user.tests::test_run",
    ] {
        assert!(node_ids.contains(&id.to_string()), "{id}");
    }
}

fn assert_rust_extraction_edges(result: &ExtractionResult) {
    let triples = edge_triples(&result.edges);
    for triple in rust_expected_edge_triples() {
        assert!(triples.contains(&triple), "{triple:?}");
    }
}

fn assert_rust_extraction_attributes(result: &ExtractionResult) -> TestResult {
    assert_eq!(
        required_attributes(&result.nodes, "struct:src/lib.rs#Widget")?
            .get("exported")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        required_attributes(&result.nodes, "struct:src/lib.rs#Widget")?
            .get("language")
            .and_then(Value::as_str),
        Some("rust")
    );
    assert_rust_run_attributes(result)?;
    assert!(result.metadata.node_kinds.contains(&"Struct".to_string()));
    assert!(result
        .metadata
        .edge_kinds
        .contains(&"IMPLEMENTS".to_string()));
    Ok(())
}

fn assert_rust_run_attributes(result: &ExtractionResult) -> TestResult {
    let attributes = required_attributes(&result.nodes, "function:src/user.rs#user::run")?;
    assert_eq!(
        attributes.get("qualifiedName").and_then(Value::as_str),
        Some("user::run")
    );
    assert!(attributes
        .get("signature")
        .and_then(Value::as_str)
        .is_some_and(|signature| signature.starts_with("pub fn run")));
    assert!(attributes
        .get("lineStart")
        .and_then(Value::as_u64)
        .is_some());
    Ok(())
}

fn rust_expected_edge_triples() -> Vec<Vec<String>> {
    [
        ("CONTAINS", "file:src/user.rs", "module:src/user.rs#user"),
        (
            "CONTAINS",
            "module:src/user.rs#user",
            "function:src/user.rs#user::run",
        ),
        (
            "CONTAINS",
            "module:src/user.rs#user.tests",
            "test:src/user.rs#user.tests::test_run",
        ),
        ("IMPORTS_FROM", "file:src/user.rs", "file:src/helpers.rs"),
        (
            "CALLS",
            "function:src/user.rs#user::run",
            "function:src/helpers.rs#helpers::assist",
        ),
        (
            "CALLS",
            "test:src/user.rs#user.tests::test_run",
            "function:src/user.rs#user::run",
        ),
        (
            "TESTED_BY",
            "function:src/user.rs#user::run",
            "test:src/user.rs#user.tests::test_run",
        ),
        (
            "IMPLEMENTS",
            "impl:src/lib.rs#impl Service for Widget",
            "trait:src/lib.rs#Service",
        ),
    ]
    .into_iter()
    .map(|(kind, from, to)| vec![kind.to_string(), from.to_string(), to.to_string()])
    .collect()
}

#[test]
fn rust_crate_use_prefers_module_file_over_lib_declaration_stub() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(&repo, "src/lib.rs", "pub mod helpers;\nmod user;\n")?;
    write(&repo, "src/helpers.rs", "pub fn assist() -> usize { 1 }\n")?;
    write(
        &repo,
        "src/user.rs",
        "use crate::helpers;\npub fn run() { helpers::assist(); }\n",
    )?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));
    let triples = edge_triples(&result.edges);

    assert!(triples.contains(&vec![
        "IMPORTS_FROM".to_string(),
        "file:src/user.rs".to_string(),
        "file:src/helpers.rs".to_string()
    ]));
    assert!(!triples.contains(&vec![
        "IMPORTS_FROM".to_string(),
        "file:src/user.rs".to_string(),
        "file:src/lib.rs".to_string()
    ]));
    Ok(())
}

#[test]
fn rust_crate_use_resolves_within_nearest_workspace_crate() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(
        &repo,
        "crates/app/src/lib.rs",
        "pub mod helpers;\nmod user;\n",
    )?;
    write(
        &repo,
        "crates/app/src/helpers.rs",
        "pub fn assist() -> usize { 1 }\n",
    )?;
    write(
        &repo,
        "crates/app/src/user.rs",
        "use crate::helpers;\npub fn run() { helpers::assist(); }\n",
    )?;
    write(
        &repo,
        "crates/other/src/lib.rs",
        "pub mod helpers;\npub fn unrelated() {}\n",
    )?;
    write(
        &repo,
        "crates/other/src/helpers.rs",
        "pub fn assist() -> usize { 2 }\n",
    )?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));
    let triples = edge_triples(&result.edges);

    assert!(triples.contains(&vec![
        "IMPORTS_FROM".to_string(),
        "file:crates/app/src/user.rs".to_string(),
        "file:crates/app/src/helpers.rs".to_string()
    ]));
    assert!(!triples.contains(&vec![
        "IMPORTS_FROM".to_string(),
        "file:crates/app/src/user.rs".to_string(),
        "file:crates/other/src/helpers.rs".to_string()
    ]));
    Ok(())
}

#[test]
fn rust_parse_errors_are_typed_and_block_empty_success() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(&repo, "src/broken.rs", "pub fn broken(")?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));

    assert_error_category(result.clone(), Category::ParseError);
    assert!(result.nodes.is_empty(), "{:?}", result.nodes);
    assert!(result.edges.is_empty(), "{:?}", result.edges);
    Ok(())
}

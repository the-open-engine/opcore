use super::support::*;
use crate::extraction::{discover_sources_for_options, extract_sources, ExtractionOptions};
use crate::protocol::{
    GraphExtractionDiagnosticCategory as Category, GraphExtractionDiagnosticSeverity as Severity,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[cfg(test)]
pub(super) struct DiagnosticsTests;

#[test]
fn oxc_parse_errors_are_typed_warnings_and_non_fatal() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(&repo, "src/broken.ts", "export function broken(")?;
    write(
        &repo,
        "src/valid.ts",
        "export function valid() { return 1; }",
    )?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));

    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.category == Category::ParseError
                && diagnostic.severity == Severity::Warning),
        "{:?}",
        result.diagnostics
    );
    assert!(
        !result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.category == Category::ParseError
                && diagnostic.severity == Severity::Error),
        "{:?}",
        result.diagnostics
    );
    required_attributes(&result.nodes, "file:src/broken.ts")?;
    required_attributes(&result.nodes, "function:src/valid.ts#valid")?;
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
fn default_discovery_has_no_legacy_four_thousand_file_ceiling() -> TestResult {
    let repo = repo_with_tsconfig()?;
    for index in 0..4_001 {
        write(
            &repo,
            &format!("src/generated/file_{index:04}.ts"),
            "export const value = 1;\n",
        )?;
    }

    let discovery = discover_sources_for_options(&ExtractionOptions::new(repo.path()));

    assert_eq!(discovery.sources.len(), 4_001);
    assert!(
        !discovery
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.category == Category::MaxFilesExceeded),
        "{:?}",
        discovery.diagnostics
    );
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
    write(&repo, "src/view.vue", "<script>export default {}</script>")?;

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

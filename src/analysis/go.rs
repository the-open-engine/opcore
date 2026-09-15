use tree_sitter::Node;

use crate::{
    analysis::{AnalysisError, GO_GRAMMAR_VERSION},
    cancel::CancelToken,
    limits::RuleLimits,
    model::{DependencyFacts, FileFacts, InterfaceFacts, SourceFile},
};

mod input;
mod interfaces;
mod metrics;
mod walk;

use input::BuildStatus;

const PARSER_NAME: &str = "tree-sitter-go";
const METRIC_SEMANTICS: &str = "opcore.go-metrics.v1";

/// Analyzes one Go source file without invoking the Go toolchain or executing repository code.
///
/// # Errors
///
/// Returns an error when the language mode is unsupported, analysis is cancelled, or a bounded
/// parser-safety preflight is exceeded.
pub fn analyze(
    file: &SourceFile,
    limits: &RuleLimits,
    cancel: &CancelToken,
) -> Result<FileFacts, AnalysisError> {
    walk::check_cancel(cancel)?;
    let target = input::validate_language_mode(file)?;
    let (source, byte_base) = input::source_without_bom(&file.bytes);
    let lines = input::LineIndex::new(source, byte_base);
    let text = match std::str::from_utf8(source) {
        Ok(text) => text,
        Err(error) => return Ok(input::invalid_utf8_facts(source, &lines, error, target)),
    };
    analyze_text(AnalysisContext {
        file,
        text,
        source,
        lines: &lines,
        target,
        limits,
        cancel,
    })
}

#[derive(Clone, Copy)]
struct AnalysisContext<'a> {
    file: &'a SourceFile,
    text: &'a str,
    source: &'a [u8],
    lines: &'a input::LineIndex,
    target: input::GoTarget<'a>,
    limits: &'a RuleLimits,
    cancel: &'a CancelToken,
}

fn analyze_text(context: AnalysisContext<'_>) -> Result<FileFacts, AnalysisError> {
    let tokens = input::scan_tokens(context.text, context.cancel)?;
    let tree = input::parse(context.text, context.cancel)?;
    let root = tree.root_node();
    let syntax = input::syntax_diagnostics(
        root,
        context.source,
        context.lines,
        context.target,
        context.cancel,
    )?;
    if !syntax.is_empty() {
        return Ok(input::parser_failed_facts(syntax));
    }
    analyze_tree(root, &tokens, &context)
}

fn analyze_tree(
    root: Node<'_>,
    tokens: &[input::GoToken],
    context: &AnalysisContext<'_>,
) -> Result<FileFacts, AnalysisError> {
    let metric_facts = metrics::extract(
        root,
        metrics::MetricInput {
            source: context.source,
            tokens,
            lines: context.lines,
            limits: context.limits,
            cancel: context.cancel,
        },
    )?;
    let build_status = input::build_status(context.file, context.text, context.target);
    let (dependencies, mut interfaces) =
        module_facts(build_status, root, context.source, tokens, context.cancel)?;
    if context.target.test {
        interfaces.exports.clear();
        interfaces.shapes.clear();
    }
    Ok(FileFacts {
        diagnostics: metric_facts.diagnostics,
        parser: PARSER_NAME.into(),
        parser_version: GO_GRAMMAR_VERSION.into(),
        dependencies,
        callable_fingerprints: metric_facts.callables,
        region_fingerprints: metric_facts.regions,
        interfaces,
    })
}

fn module_facts(
    status: BuildStatus,
    root: Node<'_>,
    source: &[u8],
    tokens: &[input::GoToken],
    cancel: &CancelToken,
) -> Result<(DependencyFacts, InterfaceFacts), AnalysisError> {
    match status {
        BuildStatus::Active => interfaces::extract(root, source, tokens, cancel),
        BuildStatus::Inactive => Ok((
            interfaces::complete_dependencies(Vec::new()),
            interfaces::complete_interfaces(),
        )),
        BuildStatus::Conditional => Ok(interfaces::conditional_facts()),
    }
}

fn node_text<'a>(node: Node<'_>, source: &'a [u8]) -> Option<&'a str> {
    std::str::from_utf8(source.get(node.start_byte()..node.end_byte())?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{DependencyExtractionStatus, FingerprintExtractionStatus},
        path::RepoPath,
        source::git::detect_language,
    };

    #[test]
    fn parses_a_minimal_file() {
        let path = RepoPath::from_protocol("main.go").unwrap();
        let (language, mode) = detect_language(&path).unwrap();
        let source = SourceFile::new(
            path,
            b"package main\nfunc main() {}\n".as_slice(),
            language,
            mode,
        );
        let facts = analyze(&source, &RuleLimits::default(), &CancelToken::new()).unwrap();
        assert!(facts.diagnostics.is_empty());
        assert_eq!(facts.parser, PARSER_NAME);
        assert_eq!(
            facts.dependencies.status,
            DependencyExtractionStatus::Complete
        );
        assert_eq!(
            facts.callable_fingerprints.status,
            FingerprintExtractionStatus::Complete
        );
    }
}

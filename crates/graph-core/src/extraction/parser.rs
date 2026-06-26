use super::diagnostics::{error, warning};
use super::discovery::DiscoveredSource;
use super::SourceLanguage;
use crate::protocol::{GraphExtractionDiagnostic, GraphExtractionDiagnosticCategory};
use oxc_allocator::Allocator;
use oxc_ast::ast::Program;
use oxc_parser::{Parser, ParserReturn};
use oxc_span::SourceType;
use std::path::Path;
use tree_sitter::Tree;

pub struct ParsedSource<'a> {
    pub program: Option<ParsedProgram<'a>>,
    pub diagnostics: Vec<GraphExtractionDiagnostic>,
}

pub enum ParsedProgram<'a> {
    Oxc(Program<'a>),
    Python(Tree),
}

pub fn parse_source<'a>(
    allocator: &'a Allocator,
    source_text: &'a str,
    source: &DiscoveredSource,
    force_missing_parser: bool,
) -> ParsedSource<'a> {
    if force_missing_parser {
        return diagnostic_result(
            source,
            GraphExtractionDiagnosticCategory::MissingParser,
            "parser dependency unavailable for requested language",
        );
    }

    if source.language == SourceLanguage::Python {
        return parse_python(source_text, source);
    }
    parse_oxc(allocator, source_text, source)
}

fn parse_oxc<'a>(
    allocator: &'a Allocator,
    source_text: &'a str,
    source: &DiscoveredSource,
) -> ParsedSource<'a> {
    let source_type = match source_type_for_source(source) {
        Ok(source_type) => source_type,
        Err(diagnostic) => return ParsedSource::from(diagnostic),
    };
    let parsed = Parser::new(allocator, source_text, source_type).parse();
    if parser_failed(&parsed) {
        return diagnostic_result(
            source,
            GraphExtractionDiagnosticCategory::ParseError,
            parser_error_message(&parsed, source_text),
        );
    }

    ParsedSource {
        program: Some(ParsedProgram::Oxc(parsed.program)),
        diagnostics: Vec::new(),
    }
}

fn parse_python<'a>(source_text: &str, source: &DiscoveredSource) -> ParsedSource<'a> {
    let mut parser = tree_sitter::Parser::new();
    let language = tree_sitter_python::LANGUAGE;
    if let Err(error_value) = parser.set_language(&language.into()) {
        return diagnostic_result(
            source,
            GraphExtractionDiagnosticCategory::MissingParser,
            format!("failed to load Python parser: {error_value}"),
        );
    }
    let Some(tree) = parser.parse(source_text, None) else {
        return diagnostic_result(
            source,
            GraphExtractionDiagnosticCategory::ParseError,
            "Python parser returned no syntax tree",
        );
    };
    let diagnostics = if tree.root_node().has_error() {
        vec![warning(
            GraphExtractionDiagnosticCategory::ParseError,
            "Python parser recovered from syntax errors; graph facts may be partial",
            Some(source.relative_path.clone()),
            Some(source.language.as_str().to_string()),
        )]
    } else {
        Vec::new()
    };
    ParsedSource {
        program: Some(ParsedProgram::Python(tree)),
        diagnostics,
    }
}

impl<'a> From<GraphExtractionDiagnostic> for ParsedSource<'a> {
    fn from(diagnostic: GraphExtractionDiagnostic) -> Self {
        Self {
            program: None,
            diagnostics: vec![diagnostic],
        }
    }
}

fn diagnostic_result<'a>(
    source: &DiscoveredSource,
    category: GraphExtractionDiagnosticCategory,
    message: impl Into<String>,
) -> ParsedSource<'a> {
    ParsedSource::from(error(
        category,
        message,
        Some(source.relative_path.clone()),
        Some(source.language.as_str().to_string()),
    ))
}

fn source_type_for_source(
    source: &DiscoveredSource,
) -> Result<SourceType, GraphExtractionDiagnostic> {
    SourceType::from_path(Path::new(&source.relative_path)).map_err(|error_value| {
        error(
            GraphExtractionDiagnosticCategory::MissingParser,
            format!("no parser source type for file: {error_value}"),
            Some(source.relative_path.clone()),
            Some(source.language.as_str().to_string()),
        )
    })
}

fn parser_failed(parsed: &ParserReturn<'_>) -> bool {
    parsed.panicked || !parsed.errors.is_empty()
}

fn parser_error_message(parsed: &ParserReturn<'_>, source_text: &str) -> String {
    parsed
        .errors
        .first()
        .map(|error_value| {
            format!(
                "{:?}",
                error_value
                    .clone()
                    .with_source_code(source_text.to_string())
            )
        })
        .unwrap_or_else(|| "parser panicked".to_string())
}

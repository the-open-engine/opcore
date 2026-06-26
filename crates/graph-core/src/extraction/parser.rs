use super::diagnostics::error;
use super::discovery::DiscoveredSource;
use crate::protocol::{GraphExtractionDiagnostic, GraphExtractionDiagnosticCategory};
use oxc_allocator::Allocator;
use oxc_ast::ast::Program;
use oxc_parser::{Parser, ParserReturn};
use oxc_span::SourceType;
use std::path::Path;

pub struct ParsedSource<'a> {
    pub program: Option<Program<'a>>,
    pub diagnostics: Vec<GraphExtractionDiagnostic>,
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
        program: Some(parsed.program),
        diagnostics: Vec::new(),
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

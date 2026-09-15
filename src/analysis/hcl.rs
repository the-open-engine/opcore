use std::collections::BTreeMap;

use serde_json::Value;

use crate::{
    analysis::{
        AnalysisError, HCL_JSON_PARSER_VERSION, HCL_PARSER_VERSION,
        parser_evidence as base_parser_evidence, preflight::bounded_structure,
        source_without_utf8_bom,
    },
    cancel::CancelToken,
    limits::MAX_STRUCTURAL_DEPTH,
    model::{FileFacts, Language, Position, RawDiagnostic, Severity, SourceFile, SourceRange},
};

const HCL_PARSER: &str = "hcl-edit";
const JSON_PARSER: &str = "serde_json";
const JSON_MAX_DEPTH: usize = 64;

/// Analyzes native HCL or HCL JSON without evaluating configuration.
///
/// # Errors
///
/// Returns an error when analysis is cancelled, the language mode is invalid, or a parser
/// safety limit is exceeded.
pub fn analyze(file: &SourceFile, cancel: &CancelToken) -> Result<FileFacts, AnalysisError> {
    check_cancel(cancel)?;
    if file.language != Language::Hcl {
        return Err(AnalysisError::Unsupported(format!(
            "{} is not HCL source",
            file.language.family()
        )));
    }
    let flavor = mode_flavor(&file.language_mode)?;
    let (source, byte_base) = source_without_bom(&file.bytes);
    analyze_source(source, byte_base, flavor, cancel)
}

fn analyze_source(
    source: &[u8],
    byte_base: usize,
    flavor: Flavor,
    cancel: &CancelToken,
) -> Result<FileFacts, AnalysisError> {
    let lines = LineIndex::new(source, byte_base);
    let text = match std::str::from_utf8(source) {
        Ok(text) => text,
        Err(error) => {
            return Ok(parser_facts(
                flavor,
                vec![invalid_utf8_diagnostic(source, &lines, error, flavor)],
            ));
        }
    };
    let max_depth = if flavor == Flavor::Json {
        JSON_MAX_DEPTH
    } else {
        MAX_STRUCTURAL_DEPTH
    };
    bounded_structure(source, "HCL", max_depth, cancel)?;
    check_cancel(cancel)?;
    let diagnostics = parse_diagnostics(text, source, &lines, flavor);
    check_cancel(cancel)?;
    Ok(parser_facts(flavor, diagnostics))
}

fn parse_diagnostics(
    text: &str,
    source: &[u8],
    lines: &LineIndex,
    flavor: Flavor,
) -> Vec<RawDiagnostic> {
    match flavor {
        Flavor::Native => hcl_edit::parser::parse_body(text)
            .err()
            .map_or_else(Vec::new, |error| {
                vec![native_syntax_diagnostic(source, lines, &error)]
            }),
        Flavor::Json => json_diagnostics(text, source, lines),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Flavor {
    Native,
    Json,
}

fn mode_flavor(mode: &str) -> Result<Flavor, AnalysisError> {
    if !mode.starts_with("hcl:") {
        return Err(AnalysisError::Unsupported(format!(
            "unsupported HCL language mode '{mode}'"
        )));
    }
    match mode.rsplit(':').next() {
        Some("native") => Ok(Flavor::Native),
        Some("json") => Ok(Flavor::Json),
        _ => Err(AnalysisError::Unsupported(format!(
            "unsupported HCL language mode '{mode}'"
        ))),
    }
}

fn parser_facts(flavor: Flavor, diagnostics: Vec<RawDiagnostic>) -> FileFacts {
    let (parser, version) = parser_identity(flavor);
    FileFacts {
        diagnostics,
        parser: parser.into(),
        parser_version: version.into(),
        ..FileFacts::default()
    }
}

fn parser_identity(flavor: Flavor) -> (&'static str, &'static str) {
    match flavor {
        Flavor::Native => (HCL_PARSER, HCL_PARSER_VERSION),
        Flavor::Json => (JSON_PARSER, HCL_JSON_PARSER_VERSION),
    }
}

fn json_diagnostics(text: &str, source: &[u8], lines: &LineIndex) -> Vec<RawDiagnostic> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(_)) => Vec::new(),
        Ok(_) => vec![syntax_diagnostic(SyntaxInput {
            source,
            lines,
            flavor: Flavor::Json,
            kind: "root-type",
            message: "IaC JSON syntax requires an object at the document root".into(),
            offset: 0,
        })],
        Err(error) => {
            let offset = lines.offset(error.line(), error.column());
            let kind = match error.classify() {
                serde_json::error::Category::Eof => "unexpected-eof",
                serde_json::error::Category::Syntax => "syntax",
                serde_json::error::Category::Data => "data",
                serde_json::error::Category::Io => "io",
            };
            vec![syntax_diagnostic(SyntaxInput {
                source,
                lines,
                flavor: Flavor::Json,
                kind,
                message: format!(
                    "Invalid IaC JSON syntax: {}",
                    stable_message(&error.to_string())
                ),
                offset,
            })]
        }
    }
}

fn native_syntax_diagnostic(
    source: &[u8],
    lines: &LineIndex,
    error: &hcl_edit::parser::Error,
) -> RawDiagnostic {
    syntax_diagnostic(SyntaxInput {
        source,
        lines,
        flavor: Flavor::Native,
        kind: "syntax",
        message: format!("Invalid HCL syntax: {}", stable_message(error.message())),
        offset: error.location().offset(),
    })
}

struct SyntaxInput<'a> {
    source: &'a [u8],
    lines: &'a LineIndex,
    flavor: Flavor,
    kind: &'a str,
    message: String,
    offset: usize,
}

fn syntax_diagnostic(input: SyntaxInput<'_>) -> RawDiagnostic {
    let offset = input.offset.min(input.source.len());
    let end = crate::analysis::next_char_end(input.source, offset);
    let anchor = crate::analysis::line_anchor(input.source, offset);
    let mut evidence = parser_evidence(input.flavor);
    evidence.insert("errorKind".into(), serde_json::json!(input.kind));
    RawDiagnostic {
        rule_id: "hcl.syntax".into(),
        severity: Severity::Error,
        message: input.message,
        range: Some(input.lines.range(offset, end)),
        entity_key: format!("syntax:{}:{anchor}", input.kind),
        cause_key: format!("parser:{}:{}", parser_identity(input.flavor).1, input.kind),
        evidence,
    }
}

fn invalid_utf8_diagnostic(
    source: &[u8],
    lines: &LineIndex,
    error: std::str::Utf8Error,
    flavor: Flavor,
) -> RawDiagnostic {
    let start = error.valid_up_to();
    let end = start
        .saturating_add(error.error_len().unwrap_or(1))
        .min(source.len());
    let mut evidence = parser_evidence(flavor);
    evidence.insert("errorKind".into(), serde_json::json!("invalid_utf8"));
    RawDiagnostic {
        rule_id: "hcl.syntax".into(),
        severity: Severity::Error,
        message: "HCL source is not valid UTF-8".into(),
        range: Some(lines.range(start, end)),
        entity_key: format!(
            "syntax:invalid-utf8:{}",
            crate::analysis::line_anchor(source, start)
        ),
        cause_key: "invalid_utf8".into(),
        evidence,
    }
}

fn parser_evidence(flavor: Flavor) -> BTreeMap<String, serde_json::Value> {
    let (parser, version) = parser_identity(flavor);
    let mut evidence = base_parser_evidence(parser, version);
    evidence.insert(
        "syntaxFlavor".into(),
        serde_json::json!(match flavor {
            Flavor::Native => "native",
            Flavor::Json => "json",
        }),
    );
    evidence
}

fn stable_message(message: &str) -> String {
    message.replace(['\r', '\n'], " ")
}

fn source_without_bom(bytes: &[u8]) -> (&[u8], usize) {
    source_without_utf8_bom(bytes)
}

fn check_cancel(cancel: &CancelToken) -> Result<(), AnalysisError> {
    if cancel.is_cancelled() {
        Err(AnalysisError::Cancelled)
    } else {
        Ok(())
    }
}

struct LineIndex {
    starts: Vec<usize>,
    source_len: usize,
    byte_base: usize,
}

impl LineIndex {
    fn new(source: &[u8], byte_base: usize) -> Self {
        let mut starts = vec![0];
        starts.extend(
            source
                .iter()
                .enumerate()
                .filter(|(_, byte)| matches!(byte, b'\r' | b'\n'))
                .filter(|(index, byte)| {
                    **byte != b'\n' || *index == 0 || source[index.saturating_sub(1)] != b'\r'
                })
                .map(|(index, byte)| {
                    index.saturating_add(1).saturating_add(usize::from(
                        *byte == b'\r' && source.get(index + 1) == Some(&b'\n'),
                    ))
                }),
        );
        Self {
            starts,
            source_len: source.len(),
            byte_base,
        }
    }

    fn position(&self, offset: usize) -> Position {
        let offset = offset.min(self.source_len);
        let line_index = self
            .starts
            .partition_point(|start| *start <= offset)
            .saturating_sub(1);
        let line_start = self.starts.get(line_index).copied().unwrap_or(0);
        Position {
            line: u32::try_from(line_index.saturating_add(1)).unwrap_or(u32::MAX),
            column: u32::try_from(offset.saturating_sub(line_start).saturating_add(1))
                .unwrap_or(u32::MAX),
            byte: u32::try_from(offset.saturating_add(self.byte_base)).unwrap_or(u32::MAX),
        }
    }

    fn range(&self, start: usize, end: usize) -> SourceRange {
        SourceRange {
            start: self.position(start),
            end: self.position(end),
        }
    }

    fn offset(&self, line: usize, column: usize) -> usize {
        let start = self
            .starts
            .get(line.saturating_sub(1))
            .copied()
            .unwrap_or(self.source_len);
        start
            .saturating_add(column.saturating_sub(1))
            .min(self.source_len)
    }
}

pub(crate) mod dedup;
pub mod go;
pub mod hcl;
mod hygiene;
mod line_index;
pub mod node;
mod preflight;
pub mod protobuf;
pub mod python;
pub mod rust;
pub mod shell;

use std::collections::BTreeMap;

use crate::{
    cancel::CancelToken,
    limits::RuleLimits,
    model::{
        DependencyExtractionStatus, DependencyFacts, FileFacts, InterfaceExtractionStatus,
        InterfaceFacts, Language, RawDiagnostic, Severity, SourceFile,
    },
};

pub const FACT_ABI: &str = "opcore.file-facts.v19";
pub(crate) const GO_GRAMMAR_VERSION: &str = "0.25.0";
pub(crate) const GO_RUNTIME_VERSION: &str = "0.26.12";
pub(crate) const HCL_PARSER_VERSION: &str = "0.9.6";
pub(crate) const HCL_JSON_PARSER_VERSION: &str = "1.0.151";
pub(crate) const NODE_PARSER_VERSION: &str = "0.142.0";
pub(crate) const PYTHON_PARSER_VERSION: &str = "0.0.7";
pub(crate) const PROTOBUF_PARSER_VERSION: &str = "0.6.0";
pub(crate) const RUST_PARSER_VERSION: &str = "0.0.344";
pub(crate) const SHELL_PARSER_VERSION: &str = "0.1.1";

pub(crate) fn parser_failed_dependencies() -> DependencyFacts {
    DependencyFacts {
        status: DependencyExtractionStatus::ParserFailed,
        references: Vec::new(),
    }
}

pub(crate) fn parser_failure_facts(
    parser: &str,
    parser_version: &str,
    diagnostics: Vec<RawDiagnostic>,
) -> FileFacts {
    FileFacts {
        diagnostics,
        parser: parser.into(),
        parser_version: parser_version.into(),
        dependencies: parser_failed_dependencies(),
        callable_fingerprints: dedup::parser_failed(),
        region_fingerprints: dedup::region_parser_failed(),
        interfaces: InterfaceFacts {
            status: InterfaceExtractionStatus::ParserFailed,
            ..InterfaceFacts::default()
        },
    }
}

pub(crate) fn parser_evidence(
    parser: &str,
    parser_version: &str,
) -> BTreeMap<String, serde_json::Value> {
    BTreeMap::from([
        ("parser".into(), serde_json::json!(parser)),
        ("parserVersion".into(), serde_json::json!(parser_version)),
    ])
}

pub(crate) fn metric_evidence(
    mut evidence: BTreeMap<String, serde_json::Value>,
    actual: u32,
    limit: u32,
) -> BTreeMap<String, serde_json::Value> {
    evidence.insert("actual".into(), serde_json::json!(actual));
    evidence.insert("limit".into(), serde_json::json!(limit));
    evidence
}

pub(crate) struct InvalidUtf8Diagnostic<'a> {
    pub(crate) language: &'a str,
    pub(crate) rule_id: &'a str,
    pub(crate) source: &'a [u8],
    pub(crate) lines: &'a line_index::LineIndex,
    pub(crate) error: std::str::Utf8Error,
    pub(crate) evidence: BTreeMap<String, serde_json::Value>,
}

pub(crate) fn invalid_utf8_diagnostic(input: InvalidUtf8Diagnostic<'_>) -> RawDiagnostic {
    let start = input.error.valid_up_to();
    let end = start
        .saturating_add(input.error.error_len().unwrap_or(1))
        .min(input.source.len());
    RawDiagnostic {
        rule_id: input.rule_id.into(),
        severity: Severity::Error,
        message: format!("{} source is not valid UTF-8", input.language),
        range: Some(input.lines.byte_range(start, end)),
        entity_key: format!("syntax:invalid-utf8:{}", line_anchor(input.source, start)),
        cause_key: "invalid_utf8".into(),
        evidence: input.evidence,
    }
}

pub(crate) fn source_without_utf8_bom(bytes: &[u8]) -> (&[u8], usize) {
    const UTF8_BOM: &[u8] = b"\xef\xbb\xbf";
    bytes
        .strip_prefix(UTF8_BOM)
        .map_or((bytes, 0), |body| (body, UTF8_BOM.len()))
}

pub(crate) fn sort_and_dedup<T: Ord>(items: &mut Vec<T>) {
    items.sort();
    items.dedup();
}

pub(crate) fn line_anchor(bytes: &[u8], offset: usize) -> String {
    let offset = offset.min(bytes.len());
    let mut start = bytes[..offset]
        .iter()
        .rposition(|byte| matches!(byte, b'\n' | b'\r'))
        .map_or(0, |index| index.saturating_add(1));
    let mut end = bytes[offset..]
        .iter()
        .position(|byte| matches!(byte, b'\n' | b'\r'))
        .map_or(bytes.len(), |index| offset.saturating_add(index));
    let mut line = trim_ascii_whitespace(
        bytes[start..end]
            .strip_prefix(b"\xef\xbb\xbf")
            .unwrap_or(&bytes[start..end]),
    );
    while line.is_empty() && start > 0 {
        end = start;
        while end > 0 && matches!(bytes[end - 1], b'\n' | b'\r') {
            end -= 1;
        }
        start = bytes[..end]
            .iter()
            .rposition(|byte| matches!(byte, b'\n' | b'\r'))
            .map_or(0, |index| index.saturating_add(1));
        line = trim_ascii_whitespace(&bytes[start..end]);
    }
    hex::encode(&crate::identity::hash_domain("source-line-anchor/v1", &[line])[..12])
}

pub(crate) fn next_char_end(source: &[u8], start: usize) -> usize {
    std::str::from_utf8(source.get(start..).unwrap_or_default())
        .ok()
        .and_then(|tail| tail.chars().next())
        .map_or(start, |character| {
            start.saturating_add(character.len_utf8())
        })
}

fn trim_ascii_whitespace(mut bytes: &[u8]) -> &[u8] {
    while bytes.first().is_some_and(u8::is_ascii_whitespace) {
        bytes = &bytes[1..];
    }
    while bytes.last().is_some_and(u8::is_ascii_whitespace) {
        bytes = &bytes[..bytes.len().saturating_sub(1)];
    }
    bytes
}

#[derive(Debug, thiserror::Error)]
pub enum AnalysisError {
    #[error("analysis cancelled")]
    Cancelled,
    #[error("unsupported source: {0}")]
    Unsupported(String),
    #[error("parser failure: {0}")]
    Parser(String),
}

pub fn analyze(
    file: &SourceFile,
    limits: &RuleLimits,
    cancel: &CancelToken,
) -> Result<FileFacts, AnalysisError> {
    if cancel.is_cancelled() {
        return Err(AnalysisError::Cancelled);
    }
    let mut facts = hygiene::analyze(file, limits)?;
    let mut language_facts = analyze_language(file, limits, cancel)?;
    facts.diagnostics.append(&mut language_facts.diagnostics);
    facts.parser = language_facts.parser;
    facts.parser_version = language_facts.parser_version;
    facts.dependencies = language_facts.dependencies;
    facts.callable_fingerprints = language_facts.callable_fingerprints;
    facts.region_fingerprints = language_facts.region_fingerprints;
    facts.interfaces = language_facts.interfaces;
    Ok(facts)
}

#[doc(hidden)]
pub fn analyze_go_for_test(
    file: &SourceFile,
    limits: &RuleLimits,
    cancel: &CancelToken,
) -> Result<FileFacts, AnalysisError> {
    go::analyze(file, limits, cancel)
}

fn analyze_language(
    file: &SourceFile,
    limits: &RuleLimits,
    cancel: &CancelToken,
) -> Result<FileFacts, AnalysisError> {
    match file.language {
        Language::JavaScript | Language::TypeScript => node::analyze(file, limits, cancel),
        Language::Rust => rust::analyze(file, limits, cancel),
        Language::Python => python::analyze(file, limits, cancel),
        Language::Go => go::analyze(file, limits, cancel),
        Language::Hcl | Language::Shell | Language::Protobuf => analyze_declarative(file, cancel),
    }
}

fn analyze_declarative(
    file: &SourceFile,
    cancel: &CancelToken,
) -> Result<FileFacts, AnalysisError> {
    match file.language {
        Language::Hcl => hcl::analyze(file, cancel),
        Language::Shell => shell::analyze(file, cancel),
        Language::Protobuf => protobuf::analyze(file, cancel),
        _ => Err(AnalysisError::Unsupported(format!(
            "{} is not declarative source",
            file.language.family()
        ))),
    }
}

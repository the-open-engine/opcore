use std::collections::BTreeMap;

use ra_ap_rustc_lexer::{FrontmatterAllowed, TokenKind, tokenize};
use ra_ap_syntax::{
    AstNode, Edition, SourceFile as RaSourceFile, SyntaxKind, SyntaxNode, TextRange, TextSize,
    WalkEvent,
    ast::{self, HasName},
};

use crate::{
    analysis::{
        AnalysisError, InvalidUtf8Diagnostic, RUST_PARSER_VERSION,
        dedup::{
            FingerprintCollector, FingerprintToken, fingerprint, parser_failed,
            region_fingerprints, region_parser_failed,
        },
        invalid_utf8_diagnostic as shared_invalid_utf8_diagnostic,
        line_index::LineIndex,
        parser_evidence as base_parser_evidence, source_without_utf8_bom,
    },
    cancel::{CANCELLATION_POLL_INTERVAL, CancelToken},
    identity::hash_domain,
    limits::{MAX_DIAGNOSTICS, MAX_STRUCTURAL_DEPTH, RuleLimits},
    model::{
        CallableFingerprintFacts, CallableKind, DependencyExtractionStatus, DependencyFacts,
        FileFacts, Language, RawDiagnostic, RegionFingerprintFacts, Severity, SourceFile,
        SourceRange,
    },
};

mod dependencies;
mod metrics;

use metrics::{RustMetricContext, metric_diagnostics};

const PARSER_NAME: &str = "ra_ap_syntax";
const METRIC_SEMANTICS: &str = "opcore.rust-metrics.v1";
/// Analyzes one Rust source file without executing repository code.
///
/// # Errors
///
/// Returns an error when analysis is cancelled, the edition is unsupported, or a hard
/// parser-safety bound is exceeded.
pub fn analyze(
    file: &SourceFile,
    limits: &RuleLimits,
    cancel: &CancelToken,
) -> Result<FileFacts, AnalysisError> {
    check_cancel(cancel)?;
    validate_rust_language(file)?;
    let editions = parse_editions(&file.language_mode)?;
    let default_edition = editions[0];
    let (source_bytes, byte_base) = source_without_bom(&file.bytes);
    let lines = LineIndex::new(source_bytes, byte_base);
    let text = match std::str::from_utf8(source_bytes) {
        Ok(text) => text,
        Err(error) => {
            return Ok(invalid_utf8_facts(
                &lines,
                source_bytes,
                error,
                default_edition,
            ));
        }
    };
    let fingerprint_tokens = preflight_structure(text, cancel)?;
    analyze_valid_rust(
        RustAnalysisInput {
            text,
            lines: &lines,
            limits,
            cancel,
            fingerprint_tokens: &fingerprint_tokens,
        },
        editions,
    )
}

#[derive(Clone, Copy)]
struct RustAnalysisInput<'a> {
    text: &'a str,
    lines: &'a LineIndex,
    limits: &'a RuleLimits,
    cancel: &'a CancelToken,
    fingerprint_tokens: &'a [RustFingerprintToken],
}

fn analyze_valid_rust(
    input: RustAnalysisInput<'_>,
    editions: Vec<Edition>,
) -> Result<FileFacts, AnalysisError> {
    let (parse, edition, mut syntax_errors) = select_parse(input.text, editions, input.cancel)?;
    check_cancel(input.cancel)?;
    sort_syntax_errors(&mut syntax_errors);
    if let Some(facts) = syntax_facts(
        &syntax_errors,
        input.lines,
        input.text,
        edition,
        input.cancel,
    )? {
        return Ok(facts);
    }
    let tree = parse.tree();
    let root = tree.syntax();
    reject_nightly_features(root)?;
    let dependencies = dependencies::extract(root, input.cancel)?;
    let (diagnostics, callable_fingerprints) = metric_diagnostics(
        root,
        RustMetricContext {
            text: input.text,
            lines: input.lines,
            edition,
            limits: input.limits,
            cancel: input.cancel,
        },
        input.fingerprint_tokens,
    )?;
    let region_fingerprints =
        rust_region_fingerprints(input.fingerprint_tokens, input.text, input.lines);
    check_cancel(input.cancel)?;
    Ok(parser_facts(
        diagnostics,
        callable_fingerprints,
        region_fingerprints,
        dependencies,
    ))
}

fn sort_syntax_errors(errors: &mut [ra_ap_syntax::SyntaxError]) {
    errors.sort_by(|left, right| {
        text_range_key(left.range())
            .cmp(&text_range_key(right.range()))
            .then_with(|| left.to_string().cmp(&right.to_string()))
    });
}

fn syntax_facts(
    errors: &[ra_ap_syntax::SyntaxError],
    lines: &LineIndex,
    text: &str,
    edition: Edition,
    cancel: &CancelToken,
) -> Result<Option<FileFacts>, AnalysisError> {
    if errors.is_empty() {
        return Ok(None);
    }
    let diagnostics = syntax_diagnostics(errors, lines, text.as_bytes(), edition, cancel)?;
    Ok(Some(parser_facts_with_status(
        diagnostics,
        DependencyExtractionStatus::ParserFailed,
        parser_failed(),
        region_parser_failed(),
    )))
}

fn parser_facts(
    diagnostics: Vec<RawDiagnostic>,
    callable_fingerprints: CallableFingerprintFacts,
    region_fingerprints: RegionFingerprintFacts,
    dependencies: DependencyFacts,
) -> FileFacts {
    FileFacts {
        diagnostics,
        parser: PARSER_NAME.into(),
        parser_version: RUST_PARSER_VERSION.into(),
        dependencies,
        callable_fingerprints,
        region_fingerprints,
        interfaces: crate::model::InterfaceFacts::default(),
    }
}

fn parser_facts_with_status(
    diagnostics: Vec<RawDiagnostic>,
    status: DependencyExtractionStatus,
    callable_fingerprints: CallableFingerprintFacts,
    region_fingerprints: RegionFingerprintFacts,
) -> FileFacts {
    FileFacts {
        diagnostics,
        parser: PARSER_NAME.into(),
        parser_version: RUST_PARSER_VERSION.into(),
        dependencies: DependencyFacts {
            status,
            references: Vec::new(),
        },
        callable_fingerprints,
        region_fingerprints,
        interfaces: crate::model::InterfaceFacts::default(),
    }
}

fn reject_nightly_features(root: &SyntaxNode) -> Result<(), AnalysisError> {
    if uses_nightly_feature(root) {
        return Err(AnalysisError::Unsupported(
            "nightly Rust feature gates are outside the stable 2018/2021/2024 envelope".into(),
        ));
    }
    Ok(())
}

fn validate_rust_language(file: &SourceFile) -> Result<(), AnalysisError> {
    if file.language == Language::Rust {
        Ok(())
    } else {
        Err(AnalysisError::Unsupported(format!(
            "{} is not Rust source",
            file.language.family()
        )))
    }
}

fn source_without_bom(bytes: &[u8]) -> (&[u8], usize) {
    source_without_utf8_bom(bytes)
}

fn invalid_utf8_facts(
    lines: &LineIndex,
    source: &[u8],
    error: std::str::Utf8Error,
    edition: Edition,
) -> FileFacts {
    FileFacts {
        diagnostics: vec![invalid_utf8_diagnostic(lines, source, error, edition)],
        parser: PARSER_NAME.into(),
        parser_version: RUST_PARSER_VERSION.into(),
        dependencies: crate::analysis::parser_failed_dependencies(),
        callable_fingerprints: parser_failed(),
        region_fingerprints: region_parser_failed(),
        interfaces: crate::model::InterfaceFacts::default(),
    }
}

fn select_parse(
    text: &str,
    editions: Vec<Edition>,
    cancel: &CancelToken,
) -> Result<
    (
        ra_ap_syntax::Parse<RaSourceFile>,
        Edition,
        Vec<ra_ap_syntax::SyntaxError>,
    ),
    AnalysisError,
> {
    check_cancel(cancel)?;
    let mut editions = editions.into_iter();
    let Some(mut edition) = editions.next() else {
        return Err(AnalysisError::Unsupported(
            "Rust language mode resolved no supported edition".into(),
        ));
    };
    let mut parse = RaSourceFile::parse(text, edition);
    let mut errors = syntax_errors_for_edition(&parse, edition);
    for candidate in editions {
        if errors.is_empty() {
            break;
        }
        let candidate_parse = RaSourceFile::parse(text, candidate);
        let candidate_errors = syntax_errors_for_edition(&candidate_parse, candidate);
        if candidate_errors.is_empty() {
            edition = candidate;
            parse = candidate_parse;
            errors = candidate_errors;
            break;
        }
    }
    Ok((parse, edition, errors))
}

fn uses_nightly_feature(root: &SyntaxNode) -> bool {
    root.descendants()
        .filter_map(ast::Attr::cast)
        .any(|attribute| {
            attribute.kind().is_inner() && attribute.simple_name().as_deref() == Some("feature")
        })
}

fn syntax_errors_for_edition(
    parse: &ra_ap_syntax::Parse<RaSourceFile>,
    edition: Edition,
) -> Vec<ra_ap_syntax::SyntaxError> {
    parse
        .errors()
        .into_iter()
        .filter(|error| {
            edition != Edition::Edition2018 || !error.to_string().contains("unknown literal prefix")
        })
        .collect()
}

fn preflight_structure(
    source: &str,
    cancel: &CancelToken,
) -> Result<Vec<RustFingerprintToken>, AnalysisError> {
    let mut structure = RustStructure::default();
    let mut fingerprint_tokens = Vec::new();
    let mut offset = 0usize;
    for (index, token) in tokenize(source, FrontmatterAllowed::No).enumerate() {
        if index.is_multiple_of(CANCELLATION_POLL_INTERVAL) {
            check_cancel(cancel)?;
        }
        let start = offset;
        offset = offset.saturating_add(usize::try_from(token.len).unwrap_or(usize::MAX));
        if !matches!(
            token.kind,
            TokenKind::Whitespace | TokenKind::LineComment { .. } | TokenKind::BlockComment { .. }
        ) {
            fingerprint_tokens.push(RustFingerprintToken { start, end: offset });
        }
        if structure.consume(token.kind) {
            structure.validate()?;
        }
    }
    Ok(fingerprint_tokens)
}

fn rust_region_fingerprints(
    tokens: &[RustFingerprintToken],
    source: &str,
    lines: &LineIndex,
) -> RegionFingerprintFacts {
    region_fingerprints(
        "rust",
        tokens.iter().map(|token| FingerprintToken {
            tag: 0,
            text: source
                .as_bytes()
                .get(token.start..token.end)
                .unwrap_or_default(),
            line: lines.position(token.start).line,
            counted: true,
            start_byte: lines.position(token.start).byte,
            end_byte: lines.position(token.end).byte,
        }),
    )
}

#[derive(Clone, Copy)]
struct RustFingerprintToken {
    start: usize,
    end: usize,
}

#[derive(Default)]
struct RustStructure {
    delimiters: usize,
    angles: usize,
    unary: usize,
    expression_nodes: usize,
    brace_expressions: Vec<usize>,
}

impl RustStructure {
    fn consume(&mut self, kind: TokenKind) -> bool {
        match kind {
            TokenKind::OpenParen | TokenKind::OpenBrace | TokenKind::OpenBracket => {
                self.open(kind);
            }
            TokenKind::CloseParen | TokenKind::CloseBrace | TokenKind::CloseBracket => {
                self.close(kind);
            }
            TokenKind::Lt => {
                self.angles = self.angles.saturating_add(1);
                self.expression_nodes = self.expression_nodes.saturating_add(1);
            }
            TokenKind::Gt => {
                self.angles = self.angles.saturating_sub(1);
                self.expression_nodes = self.expression_nodes.saturating_add(1);
            }
            TokenKind::Plus
            | TokenKind::Minus
            | TokenKind::Star
            | TokenKind::Slash
            | TokenKind::And
            | TokenKind::Or
            | TokenKind::Caret
            | TokenKind::Percent
            | TokenKind::Eq
            | TokenKind::Dot
            | TokenKind::Question => {
                self.operator(kind);
            }
            TokenKind::Semi | TokenKind::Comma => {
                self.angles = 0;
                self.unary = 0;
                self.expression_nodes = 0;
            }
            TokenKind::Bang | TokenKind::Tilde => self.unary = self.unary.saturating_add(1),
            TokenKind::Whitespace
            | TokenKind::LineComment { .. }
            | TokenKind::BlockComment { .. } => return false,
            _ => self.unary = 0,
        }
        true
    }

    fn open(&mut self, kind: TokenKind) {
        self.delimiters = self.delimiters.saturating_add(1);
        if matches!(kind, TokenKind::OpenBrace) {
            self.brace_expressions.push(self.expression_nodes);
            self.angles = 0;
            self.expression_nodes = 0;
        } else {
            self.expression_nodes = self.expression_nodes.saturating_add(1);
        }
        self.unary = 0;
    }

    fn close(&mut self, kind: TokenKind) {
        self.delimiters = self.delimiters.saturating_sub(1);
        if matches!(kind, TokenKind::CloseBrace) {
            self.angles = 0;
            self.expression_nodes = self.brace_expressions.pop().unwrap_or(0);
        }
        self.unary = 0;
    }

    fn operator(&mut self, kind: TokenKind) {
        self.expression_nodes = self.expression_nodes.saturating_add(1);
        if matches!(kind, TokenKind::Minus | TokenKind::Star | TokenKind::And) {
            self.unary = self.unary.saturating_add(1);
        } else {
            self.unary = 0;
        }
    }

    fn validate(&self) -> Result<(), AnalysisError> {
        if self.delimiters > MAX_STRUCTURAL_DEPTH
            || self.angles > MAX_STRUCTURAL_DEPTH
            || self.unary > MAX_STRUCTURAL_DEPTH
            || self.expression_nodes > MAX_STRUCTURAL_DEPTH
        {
            return Err(AnalysisError::Unsupported(format!(
                "source structural depth exceeds the {MAX_STRUCTURAL_DEPTH}-level safety limit"
            )));
        }
        Ok(())
    }
}

fn parse_editions(mode: &str) -> Result<Vec<Edition>, AnalysisError> {
    match mode.trim().to_ascii_lowercase().as_str() {
        "2018" | "rust2018" | "rust-2018" | "rust:2018" | "edition2018" => {
            Ok(vec![Edition::Edition2018])
        }
        "2021" | "rust2021" | "rust-2021" | "rust:2021" | "edition2021" => {
            Ok(vec![Edition::Edition2021])
        }
        "2024" | "rust2024" | "rust-2024" | "rust:2024" | "edition2024" => {
            Ok(vec![Edition::Edition2024])
        }
        "stable" | "rust:stable" => Ok(vec![
            Edition::Edition2024,
            Edition::Edition2021,
            Edition::Edition2018,
        ]),
        _ => Err(AnalysisError::Unsupported(format!(
            "unsupported Rust language mode '{mode}'; expected stable edition 2018, 2021, or 2024"
        ))),
    }
}

fn syntax_diagnostics(
    errors: &[ra_ap_syntax::SyntaxError],
    lines: &LineIndex,
    source: &[u8],
    edition: Edition,
    cancel: &CancelToken,
) -> Result<Vec<RawDiagnostic>, AnalysisError> {
    let truncated = errors.len() > MAX_DIAGNOSTICS;
    let retained = if truncated {
        MAX_DIAGNOSTICS.saturating_sub(1)
    } else {
        errors.len()
    };
    let mut diagnostics = Vec::with_capacity(retained.saturating_add(usize::from(truncated)));
    let mut message_occurrences = BTreeMap::<String, usize>::new();

    for (index, error) in errors.iter().take(retained).enumerate() {
        if index.is_multiple_of(CANCELLATION_POLL_INTERVAL) {
            check_cancel(cancel)?;
        }
        let message = stable_message(&error.to_string());
        let anchor = crate::analysis::line_anchor(source, usize::from(error.range().start()));
        let occurrence_key = format!("{message}:{anchor}");
        let occurrence = message_occurrences.entry(occurrence_key).or_default();
        let entity_key = format!("syntax:{message}:{anchor}:{}", *occurrence);
        *occurrence = occurrence.saturating_add(1);
        let mut evidence = parser_evidence(edition);
        evidence.insert("errorKind".into(), serde_json::json!("parser"));
        diagnostics.push(RawDiagnostic {
            rule_id: "rust.syntax".into(),
            severity: Severity::Error,
            message: format!("Rust syntax error: {message}"),
            range: Some(lines.byte_range(
                usize::from(error.range().start()),
                usize::from(error.range().end()),
            )),
            entity_key,
            cause_key: format!("parser:{RUST_PARSER_VERSION}:{message}"),
            evidence,
        });
    }

    if truncated {
        let mut evidence = parser_evidence(edition);
        evidence.insert("actual".into(), serde_json::json!(errors.len()));
        evidence.insert("retained".into(), serde_json::json!(retained));
        evidence.insert("truncated".into(), serde_json::json!(true));
        diagnostics.push(RawDiagnostic {
            rule_id: "rust.syntax".into(),
            severity: Severity::Error,
            message: format!(
                "Rust parser produced {} errors; only the first {retained} are reported",
                errors.len()
            ),
            range: None,
            entity_key: "syntax:truncated".into(),
            cause_key: format!("parser:{RUST_PARSER_VERSION}:truncated"),
            evidence,
        });
    }
    check_cancel(cancel)?;
    Ok(diagnostics)
}

fn invalid_utf8_diagnostic(
    lines: &LineIndex,
    source: &[u8],
    error: std::str::Utf8Error,
    edition: Edition,
) -> RawDiagnostic {
    let mut evidence = parser_evidence(edition);
    evidence.insert("errorKind".into(), serde_json::json!("invalid_utf8"));
    shared_invalid_utf8_diagnostic(InvalidUtf8Diagnostic {
        language: "Rust",
        rule_id: "rust.syntax",
        source,
        lines,
        error,
        evidence,
    })
}

fn parser_evidence(edition: Edition) -> BTreeMap<String, serde_json::Value> {
    let mut evidence = base_parser_evidence(PARSER_NAME, RUST_PARSER_VERSION);
    evidence.insert("edition".into(), serde_json::json!(edition.to_string()));
    evidence
}

fn stable_message(message: &str) -> String {
    message.replace(['\r', '\n'], " ")
}

fn check_cancel(cancel: &CancelToken) -> Result<(), AnalysisError> {
    if cancel.is_cancelled() {
        Err(AnalysisError::Cancelled)
    } else {
        Ok(())
    }
}

fn text_range_key(range: TextRange) -> (u32, u32) {
    (u32::from(range.start()), u32::from(range.end()))
}

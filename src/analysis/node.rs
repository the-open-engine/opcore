use std::collections::{BTreeMap, BTreeSet};

use oxc_allocator::Allocator;
use oxc_ast::{
    ast::{Expression, FormalParameters, Function, PropertyKind},
    ast_kind::AstKind,
};
use oxc_ast_visit::Visit;
use oxc_parser::{Kind, Parser, ParserReturn, config::TokensParserConfig};
use oxc_span::SourceType;

use crate::{
    analysis::{
        AnalysisError, NODE_PARSER_VERSION,
        dedup::{
            FingerprintCollector, FingerprintToken, fingerprint, parser_failed,
            region_fingerprints, region_parser_failed,
        },
        parser_evidence as base_parser_evidence,
    },
    cancel::{CANCELLATION_POLL_INTERVAL, CancelToken},
    limits::RuleLimits,
    model::{
        CallableFingerprintFacts, CallableKind, FileFacts, Language, Position, RawDiagnostic,
        RegionFingerprintFacts, Severity, SourceFile, SourceRange,
    },
};

mod dependencies;
mod interfaces;
mod metrics;
mod preflight;
mod source_positions;

use metrics::metric_diagnostics;
use preflight::preflight_structure;
use source_positions::{LineIndex, byte_range};

const PARSER_NAME: &str = "oxc-parser";

/// Analyzes one JavaScript or TypeScript source file.
///
/// # Errors
///
/// Returns an error when analysis is cancelled, the language mode is unsupported, or a hard
/// parser-safety bound is exceeded.
pub fn analyze(
    file: &SourceFile,
    limits: &RuleLimits,
    cancel: &CancelToken,
) -> Result<FileFacts, AnalysisError> {
    check_cancel(cancel)?;
    let source_type = source_type(file)?;
    let source = match std::str::from_utf8(&file.bytes) {
        Ok(source) => source,
        Err(error) => return Ok(invalid_utf8_facts(file, error)),
    };
    preflight_structure(source, cancel)?;

    let allocator = Allocator::default();
    let line_index = LineIndex::new(source.as_bytes());
    let parsed = Parser::new(&allocator, source, source_type)
        .with_config(TokensParserConfig)
        .parse();
    check_cancel(cancel)?;

    let mut diagnostics = syntax_diagnostics(&parsed, source, &line_index);
    let tokens = lex_tokens(&parsed, source, &line_index, cancel)?;
    let parsed_callables = parsed_callables(&parsed);
    let dependencies = dependencies::extract(&parsed, &tokens, file);
    let interfaces = interfaces::extract(&parsed, &tokens, &file.language_mode);
    let (callable_fingerprints, region_fingerprints) = append_metrics(
        &mut diagnostics,
        MetricInputs {
            tokens: &tokens,
            parsed_callables: &parsed_callables,
            limits,
            cancel,
            parser_panicked: parsed.panicked,
        },
    )?;
    sort_diagnostics(&mut diagnostics);

    Ok(FileFacts {
        diagnostics,
        parser: PARSER_NAME.into(),
        parser_version: NODE_PARSER_VERSION.into(),
        dependencies,
        callable_fingerprints,
        region_fingerprints,
        interfaces,
    })
}

fn syntax_diagnostics(
    parsed: &ParserReturn<'_>,
    source: &str,
    line_index: &LineIndex,
) -> Vec<RawDiagnostic> {
    let mut diagnostics = parsed
        .diagnostics
        .iter()
        .map(|diagnostic| {
            let range = diagnostic.labels.iter().next().map_or_else(
                || byte_range(source.as_bytes(), 0, 0),
                |label| {
                    let start = label.offset() as usize;
                    let start = start.min(source.len());
                    let end = start.saturating_add(label.len() as usize).min(source.len());
                    line_index.range(start, end)
                },
            );
            let line_anchor =
                crate::analysis::line_anchor(source.as_bytes(), range.start.byte as usize);
            syntax_diagnostic(diagnostic.message.to_string(), range, &line_anchor)
        })
        .collect::<Vec<_>>();
    diagnostics.sort_by(|left, right| {
        left.range
            .map(|range| range.start.byte)
            .cmp(&right.range.map(|range| range.start.byte))
            .then_with(|| left.message.cmp(&right.message))
    });
    diagnostics.dedup_by(|left, right| left.range == right.range && left.message == right.message);
    diagnostics
}

fn lex_tokens(
    parsed: &ParserReturn<'_>,
    source: &str,
    line_index: &LineIndex,
    cancel: &CancelToken,
) -> Result<Vec<LexToken>, AnalysisError> {
    parsed
        .tokens
        .iter()
        .filter(|token| !token.kind().is_eof())
        .enumerate()
        .map(|(index, token)| {
            if index.is_multiple_of(CANCELLATION_POLL_INTERVAL) {
                check_cancel(cancel)?;
            }
            let start = token.start() as usize;
            let end = token.end() as usize;
            let start_position = line_index.position(start);
            Ok(LexToken {
                kind: token.kind(),
                start_position,
                end_position: line_index.position(end),
                text: source.get(start..end).unwrap_or_default().to_owned(),
            })
        })
        .collect()
}

fn parsed_callables(parsed: &ParserReturn<'_>) -> Vec<ParsedCallable> {
    let mut collector = ParsedCallableCollector::default();
    collector.visit_program(&parsed.program);
    collector.callables
}

#[derive(Default)]
struct ParsedCallableCollector {
    callables: Vec<ParsedCallable>,
    method_parameters: BTreeSet<(u32, u32)>,
}

#[derive(Clone, Copy)]
struct ParsedCallable {
    span: (u32, u32),
    parameters: (u32, u32),
    parameter_count: u32,
    body: Option<(u32, u32)>,
    expression: bool,
    kind: CallableKind,
}

impl ParsedCallableCollector {
    fn record_function(&mut self, span: (u32, u32), function: &Function<'_>, kind: CallableKind) {
        if let Some(body) = &function.body {
            self.callables.push(ParsedCallable {
                span,
                parameters: (function.params.span.start, function.params.span.end),
                parameter_count: formal_parameter_count(&function.params),
                body: Some((body.span.start, body.span.end)),
                expression: false,
                kind,
            });
        }
    }
}

impl<'ast> Visit<'ast> for ParsedCallableCollector {
    fn enter_node(&mut self, kind: AstKind<'ast>) {
        match kind {
            AstKind::MethodDefinition(method) => {
                let parameters = (method.value.params.span.start, method.value.params.span.end);
                self.method_parameters.insert(parameters);
                self.record_function(
                    (method.span.start, method.span.end),
                    &method.value,
                    CallableKind::Method,
                );
            }
            AstKind::ObjectProperty(property)
                if property.method || property.kind != PropertyKind::Init =>
            {
                if let Expression::FunctionExpression(function) = &property.value {
                    let parameters = (function.params.span.start, function.params.span.end);
                    self.method_parameters.insert(parameters);
                    self.record_function(
                        (property.span.start, property.span.end),
                        function,
                        CallableKind::Method,
                    );
                }
            }
            AstKind::Function(function) => {
                let parameters = (function.params.span.start, function.params.span.end);
                if !self.method_parameters.contains(&parameters) {
                    self.callables.push(ParsedCallable {
                        span: (function.span.start, function.span.end),
                        parameters,
                        parameter_count: formal_parameter_count(&function.params),
                        body: function
                            .body
                            .as_ref()
                            .map(|body| (body.span.start, body.span.end)),
                        expression: false,
                        kind: CallableKind::Function,
                    });
                }
            }
            AstKind::ArrowFunctionExpression(arrow) => {
                self.callables.push(ParsedCallable {
                    span: (arrow.span.start, arrow.span.end),
                    parameters: (arrow.params.span.start, arrow.params.span.end),
                    parameter_count: formal_parameter_count(&arrow.params),
                    body: Some((arrow.body.span.start, arrow.body.span.end)),
                    expression: arrow.expression,
                    kind: CallableKind::Arrow,
                });
            }
            _ => {}
        }
    }
}

fn formal_parameter_count(parameters: &FormalParameters<'_>) -> u32 {
    u32::try_from(parameters.items.len())
        .unwrap_or(u32::MAX)
        .saturating_add(u32::from(parameters.rest.is_some()))
}

fn append_metrics(
    diagnostics: &mut Vec<RawDiagnostic>,
    input: MetricInputs<'_>,
) -> Result<(CallableFingerprintFacts, RegionFingerprintFacts), AnalysisError> {
    // Recovered token streams are useful for syntax locations, but are not safe input for
    // complexity facts: parser recovery can invent or discard delimiters.
    if diagnostics.is_empty() && !input.parser_panicked {
        let delimiters = Delimiters::new(input.tokens);
        let functions = discover_functions(input.tokens, &delimiters, input.parsed_callables);
        diagnostics.extend(metric_diagnostics(
            input.tokens,
            &delimiters,
            &functions,
            input.limits,
            input.cancel,
        )?);
        return Ok((
            callable_fingerprints(input.tokens, &functions),
            region_fingerprints("node", normalized_tokens(input.tokens)),
        ));
    }
    Ok((parser_failed(), region_parser_failed()))
}

#[derive(Clone, Copy)]
struct MetricInputs<'a> {
    tokens: &'a [LexToken],
    parsed_callables: &'a [ParsedCallable],
    limits: &'a RuleLimits,
    cancel: &'a CancelToken,
    parser_panicked: bool,
}

fn sort_diagnostics(diagnostics: &mut [RawDiagnostic]) {
    diagnostics.sort_by(|left, right| {
        left.range
            .map(|range| range.start.byte)
            .cmp(&right.range.map(|range| range.start.byte))
            .then_with(|| left.rule_id.cmp(&right.rule_id))
            .then_with(|| left.entity_key.cmp(&right.entity_key))
    });
}

fn invalid_utf8_facts(file: &SourceFile, error: std::str::Utf8Error) -> FileFacts {
    let start = error.valid_up_to();
    let end = start
        .saturating_add(error.error_len().unwrap_or(1))
        .min(file.bytes.len());
    let line_anchor = crate::analysis::line_anchor(&file.bytes, start);
    FileFacts {
        diagnostics: vec![syntax_diagnostic(
            "source is not valid UTF-8",
            byte_range(&file.bytes, start, end),
            &line_anchor,
        )],
        parser: PARSER_NAME.into(),
        parser_version: NODE_PARSER_VERSION.into(),
        dependencies: crate::analysis::parser_failed_dependencies(),
        callable_fingerprints: parser_failed(),
        region_fingerprints: region_parser_failed(),
        interfaces: crate::model::InterfaceFacts {
            status: crate::model::InterfaceExtractionStatus::ParserFailed,
            ..crate::model::InterfaceFacts::default()
        },
    }
}

fn source_type(file: &SourceFile) -> Result<SourceType, AnalysisError> {
    let source_type = SourceType::from_path(file.path.to_path_buf())
        .map_err(|error| AnalysisError::Unsupported(error.to_string()))?;
    validate_source_language(file, source_type)?;
    Ok(resolve_ambiguous_mode(source_type, &file.language_mode))
}

fn validate_source_language(
    file: &SourceFile,
    source_type: SourceType,
) -> Result<(), AnalysisError> {
    match file.language {
        Language::JavaScript if !source_type.is_javascript() => {
            return Err(AnalysisError::Unsupported(format!(
                "JavaScript language does not match {}",
                file.path
            )));
        }
        Language::TypeScript if !source_type.is_typescript() => {
            return Err(AnalysisError::Unsupported(format!(
                "TypeScript language does not match {}",
                file.path
            )));
        }
        Language::JavaScript | Language::TypeScript => {}
        _ => {
            return Err(AnalysisError::Unsupported(format!(
                "{} is not a Node-family language",
                file.language.family()
            )));
        }
    }

    Ok(())
}

fn resolve_ambiguous_mode(source_type: SourceType, mode: &str) -> SourceType {
    if !source_type.is_unambiguous() {
        return source_type;
    }
    let has_component = |candidate: &str| {
        mode.split(':')
            .any(|component| component.eq_ignore_ascii_case(candidate))
    };
    if has_component("commonjs") || has_component("cjs") {
        source_type.with_commonjs(true)
    } else if has_component("module") || has_component("esm") {
        source_type.with_module(true)
    } else if has_component("script") {
        source_type.with_script(true)
    } else {
        source_type
    }
}

fn syntax_diagnostic(
    message: impl Into<String>,
    range: SourceRange,
    line_anchor: &str,
) -> RawDiagnostic {
    let message = message.into();
    let mut evidence = parser_evidence();
    evidence.insert("source".into(), serde_json::json!("oxc"));
    RawDiagnostic {
        rule_id: "node.syntax".into(),
        severity: Severity::Error,
        message: message.clone(),
        range: Some(range),
        entity_key: syntax_entity(&message, line_anchor),
        cause_key: message,
        evidence,
    }
}

fn syntax_entity(message: &str, line_anchor: &str) -> String {
    let normalized = message
        .chars()
        .map(|character| {
            if character.is_ascii_digit() {
                '#'
            } else {
                character
            }
        })
        .collect::<String>();
    format!("syntax:{normalized}:{line_anchor}")
}

fn parser_evidence() -> BTreeMap<String, serde_json::Value> {
    base_parser_evidence(PARSER_NAME, NODE_PARSER_VERSION)
}

#[derive(Clone, Debug)]
struct LexToken {
    kind: Kind,
    start_position: Position,
    end_position: Position,
    text: String,
}

#[derive(Debug)]
struct Delimiters {
    paren_open: Vec<Option<usize>>,
    paren_close: Vec<Option<usize>>,
    brace_open: Vec<Option<usize>>,
    brace_close: Vec<Option<usize>>,
    bracket_open: Vec<Option<usize>>,
    bracket_close: Vec<Option<usize>>,
}

impl Delimiters {
    fn new(tokens: &[LexToken]) -> Self {
        let len = tokens.len();
        let mut delimiters = Self {
            paren_open: vec![None; len],
            paren_close: vec![None; len],
            brace_open: vec![None; len],
            brace_close: vec![None; len],
            bracket_open: vec![None; len],
            bracket_close: vec![None; len],
        };
        let mut parens = Vec::new();
        let mut braces = Vec::new();
        let mut brackets = Vec::new();
        for (index, token) in tokens.iter().enumerate() {
            match token.kind {
                Kind::LParen => parens.push(index),
                Kind::RParen => pair(
                    &mut parens,
                    &mut delimiters.paren_open,
                    &mut delimiters.paren_close,
                    index,
                ),
                Kind::LCurly => braces.push(index),
                Kind::RCurly => pair(
                    &mut braces,
                    &mut delimiters.brace_open,
                    &mut delimiters.brace_close,
                    index,
                ),
                Kind::LBrack => brackets.push(index),
                Kind::RBrack => pair(
                    &mut brackets,
                    &mut delimiters.bracket_open,
                    &mut delimiters.bracket_close,
                    index,
                ),
                _ => {}
            }
        }
        delimiters
    }
}

fn pair(
    stack: &mut Vec<usize>,
    open_to_close: &mut [Option<usize>],
    close_to_open: &mut [Option<usize>],
    close: usize,
) {
    if let Some(open) = stack.pop() {
        open_to_close[open] = Some(close);
        close_to_open[close] = Some(open);
    }
}

#[derive(Clone, Debug)]
struct FunctionFact {
    start: usize,
    end: usize,
    params_open: usize,
    parameter_count: u32,
    body: Option<(usize, usize)>,
    name: String,
    kind: CallableKind,
}

fn discover_functions(
    tokens: &[LexToken],
    delimiters: &Delimiters,
    parsed_callables: &[ParsedCallable],
) -> Vec<FunctionFact> {
    let mut functions = parsed_callables
        .iter()
        .filter_map(|callable| parsed_callable_fact(tokens, delimiters, *callable))
        .collect();
    sort_functions(&mut functions);
    functions
}

fn parsed_callable_fact(
    tokens: &[LexToken],
    delimiters: &Delimiters,
    callable: ParsedCallable,
) -> Option<FunctionFact> {
    let (start, _) = token_span(tokens, callable.span)?;
    let (params_open, params_close) = parameter_span(tokens, delimiters, callable.parameters)?;
    let (body, end) = parsed_callable_body(tokens, delimiters, callable, params_close)?;
    let name = match callable.kind {
        CallableKind::Arrow => arrow_name(tokens, start),
        CallableKind::Method => method_name(tokens, params_open),
        _ => function_name(tokens, start, params_open),
    };
    Some(FunctionFact {
        start,
        end,
        params_open,
        parameter_count: callable.parameter_count,
        body,
        name,
        kind: callable.kind,
    })
}

fn parsed_callable_body(
    tokens: &[LexToken],
    delimiters: &Delimiters,
    callable: ParsedCallable,
    params_close: usize,
) -> Option<(Option<(usize, usize)>, usize)> {
    let Some(body_span) = callable.body else {
        return Some((None, params_close));
    };
    let (body_open, body_close) = token_span(tokens, body_span)?;
    if callable.expression {
        let search_start = params_close.saturating_add(1);
        let arrow = tokens
            .get(search_start..=body_open)?
            .iter()
            .rposition(|token| token.kind == Kind::Arrow)?
            + search_start;
        return Some((Some((arrow, body_close.saturating_add(1))), body_close));
    }
    (tokens[body_open].kind == Kind::LCurly
        && tokens[body_close].kind == Kind::RCurly
        && delimiters.brace_open[body_open] == Some(body_close))
    .then_some((Some((body_open, body_close)), body_close))
}

fn token_span(tokens: &[LexToken], (start, end): (u32, u32)) -> Option<(usize, usize)> {
    let first = tokens.partition_point(|token| token.start_position.byte < start);
    let last = tokens
        .partition_point(|token| token.start_position.byte < end)
        .checked_sub(1)?;
    (first <= last
        && tokens[first].start_position.byte == start
        && tokens[last].end_position.byte == end)
        .then_some((first, last))
}

fn parameter_span(
    tokens: &[LexToken],
    delimiters: &Delimiters,
    span: (u32, u32),
) -> Option<(usize, usize)> {
    let (open, close) = token_span(tokens, span)?;
    if open == close {
        return Some((open, close));
    }
    (tokens[open].kind == Kind::LParen
        && tokens[close].kind == Kind::RParen
        && delimiters.paren_open[open] == Some(close))
    .then_some((open, close))
}

fn sort_functions(functions: &mut Vec<FunctionFact>) {
    functions.sort_by(|left, right| {
        left.start
            .cmp(&right.start)
            .then_with(|| right.end.cmp(&left.end))
            .then_with(|| left.name.cmp(&right.name))
    });
    functions
        .dedup_by(|left, right| left.params_open == right.params_open && left.end == right.end);
}

fn callable_fingerprints(
    tokens: &[LexToken],
    functions: &[FunctionFact],
) -> CallableFingerprintFacts {
    let mut collector = FingerprintCollector::default();
    let mut enclosing_end = None;
    for function in functions {
        let nested = enclosing_end.is_some_and(|end| function.start <= end);
        if nested {
            continue;
        }
        enclosing_end = Some(function.end);
        let Some((open, close)) = function.body else {
            continue;
        };
        let start = open.saturating_add(1);
        if start >= close || close > tokens.len() {
            continue;
        }
        let body = &tokens[start..close];
        let range = SourceRange {
            start: body[0].start_position,
            end: body[body.len() - 1].end_position,
        };
        collector.push(fingerprint(
            "node",
            function.kind,
            range,
            normalized_tokens(body),
        ));
    }
    collector.finish()
}

fn normalized_tokens(tokens: &[LexToken]) -> impl Iterator<Item = FingerprintToken<'_>> {
    let mut prior_end_line = None;
    tokens.iter().flat_map(move |token| {
        let line_break = prior_end_line
            .is_some_and(|line| token.start_position.line > line)
            .then_some(FingerprintToken {
                tag: 1,
                text: &[],
                line: token.start_position.line,
                counted: false,
                start_byte: token.start_position.byte,
                end_byte: token.start_position.byte,
            });
        prior_end_line = Some(token.end_position.line);
        [
            line_break,
            Some(FingerprintToken {
                tag: 0,
                text: token.text.as_bytes(),
                line: token.start_position.line,
                counted: true,
                start_byte: token.start_position.byte,
                end_byte: token.end_position.byte,
            }),
        ]
        .into_iter()
        .flatten()
    })
}

fn function_name(tokens: &[LexToken], function: usize, params_open: usize) -> String {
    tokens
        .get(function.saturating_add(1)..params_open)
        .unwrap_or_default()
        .iter()
        .find(|token| matches!(token.kind, Kind::Ident | Kind::PrivateIdentifier))
        .map_or_else(|| "anonymous".into(), |token| token.text.clone())
}

fn arrow_name(tokens: &[LexToken], start: usize) -> String {
    if start >= 2
        && tokens[start - 1].kind == Kind::Eq
        && is_parameter_token(tokens[start - 2].kind)
    {
        return tokens[start - 2].text.clone();
    }
    "anonymous-arrow".into()
}

fn method_name(tokens: &[LexToken], params_open: usize) -> String {
    params_open
        .checked_sub(1)
        .and_then(|index| tokens.get(index))
        .map_or_else(|| "anonymous-method".into(), |token| token.text.clone())
}

const fn is_parameter_token(kind: Kind) -> bool {
    matches!(
        kind,
        Kind::Ident
            | Kind::PrivateIdentifier
            | Kind::This
            | Kind::Constructor
            | Kind::Get
            | Kind::Set
            | Kind::String
            | Kind::Number
    )
}

fn check_cancel(cancel: &CancelToken) -> Result<(), AnalysisError> {
    if cancel.is_cancelled() {
        Err(AnalysisError::Cancelled)
    } else {
        Ok(())
    }
}

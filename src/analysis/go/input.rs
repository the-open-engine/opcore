use std::{collections::BTreeMap, ops::ControlFlow};

use tree_sitter::{Node, ParseOptions, Parser, Point, Tree};

use crate::{
    analysis::{
        AnalysisError, GO_GRAMMAR_VERSION, GO_RUNTIME_VERSION, InvalidUtf8Diagnostic,
        invalid_utf8_diagnostic as shared_invalid_utf8_diagnostic,
        parser_evidence as base_parser_evidence, parser_failure_facts, source_without_utf8_bom,
    },
    cancel::{CANCELLATION_POLL_INTERVAL, CancelToken},
    limits::{MAX_DIAGNOSTICS, MAX_STRUCTURAL_DEPTH},
    model::{FileFacts, Language, RawDiagnostic, Severity, SourceFile},
};

use super::{PARSER_NAME, walk};

pub(super) use crate::analysis::line_index::LineIndex;

#[derive(Clone, Copy)]
pub(super) struct GoTarget<'a> {
    pub(super) os: &'a str,
    pub(super) arch: &'a str,
    pub(super) test: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum BuildStatus {
    Active,
    Inactive,
    Conditional,
}

#[derive(Clone, Copy)]
pub(super) struct GoToken {
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) tag: u8,
    pub(super) counted: bool,
    pub(super) synthetic_newline: bool,
}

pub(super) fn validate_language_mode(file: &SourceFile) -> Result<GoTarget<'_>, AnalysisError> {
    if file.language != Language::Go {
        return Err(AnalysisError::Unsupported(format!(
            "{} is not Go source",
            file.language.family()
        )));
    }
    let parts = file.language_mode.split(':').collect::<Vec<_>>();
    match parts.as_slice() {
        ["go", kind @ ("source" | "test"), os, arch] if !os.is_empty() && !arch.is_empty() => {
            Ok(GoTarget {
                os,
                arch,
                test: *kind == "test",
            })
        }
        _ => Err(AnalysisError::Unsupported(format!(
            "unsupported Go language mode '{}'; expected go:source:<goos>:<goarch> or go:test:<goos>:<goarch>",
            file.language_mode
        ))),
    }
}

pub(super) fn source_without_bom(bytes: &[u8]) -> (&[u8], usize) {
    source_without_utf8_bom(bytes)
}

pub(super) fn parse(source: &str, cancel: &CancelToken) -> Result<Tree, AnalysisError> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_go::LANGUAGE.into())
        .map_err(|error| AnalysisError::Parser(error.to_string()))?;
    let bytes = source.as_bytes();
    let mut input = |offset: usize, _: Point| bytes.get(offset..).unwrap_or_default();
    let cancelled = std::cell::Cell::new(false);
    let mut progress = |_: &tree_sitter::ParseState| {
        if cancel.is_cancelled() {
            cancelled.set(true);
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    };
    let options = ParseOptions::new().progress_callback(&mut progress);
    parser
        .parse_with_options(&mut input, None, Some(options))
        .ok_or_else(|| parse_failure(cancelled.get()))
}

fn parse_failure(cancelled: bool) -> AnalysisError {
    if cancelled {
        AnalysisError::Cancelled
    } else {
        AnalysisError::Parser("Go parser did not produce a syntax tree".into())
    }
}

pub(super) fn build_status(file: &SourceFile, source: &str, target: GoTarget<'_>) -> BuildStatus {
    if filename_constraint(file, target).is_some_and(|active| !active) {
        return BuildStatus::Inactive;
    }
    evaluate_build_directives(source, target)
}

fn evaluate_build_directives(source: &str, target: GoTarget<'_>) -> BuildStatus {
    let directives = collect_build_directives(source);
    let result = match directives.modern.as_slice() {
        [] => evaluate_legacy(&directives.legacy, target),
        [expression] => BuildExpression::parse(expression, target),
        _ => Truth::Unknown,
    };
    match result {
        Truth::True => BuildStatus::Active,
        Truth::False => BuildStatus::Inactive,
        Truth::Unknown => BuildStatus::Conditional,
    }
}

#[derive(Default)]
struct BuildDirectives<'a> {
    modern: Vec<&'a str>,
    legacy: Vec<&'a str>,
}

fn collect_build_directives(source: &str) -> BuildDirectives<'_> {
    let mut directives = BuildDirectives::default();
    for line in source.lines() {
        let line = line.trim_start();
        if line.starts_with("package ") || line.starts_with("package\t") {
            break;
        }
        if let Some(expression) = line.strip_prefix("//go:build") {
            if expression.starts_with([' ', '\t']) {
                directives.modern.push(expression.trim());
            }
        } else if let Some(expression) = line.strip_prefix("// +build")
            && expression.starts_with([' ', '\t'])
        {
            directives.legacy.push(expression.trim());
        }
    }
    directives
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Truth {
    False,
    True,
    Unknown,
}

impl Truth {
    const fn not(self) -> Self {
        match self {
            Self::False => Self::True,
            Self::True => Self::False,
            Self::Unknown => Self::Unknown,
        }
    }

    const fn and(self, other: Self) -> Self {
        match (self, other) {
            (Self::False, _) | (_, Self::False) => Self::False,
            (Self::True, Self::True) => Self::True,
            _ => Self::Unknown,
        }
    }

    const fn or(self, other: Self) -> Self {
        match (self, other) {
            (Self::True, _) | (_, Self::True) => Self::True,
            (Self::False, Self::False) => Self::False,
            _ => Self::Unknown,
        }
    }
}

struct BuildExpression<'a> {
    bytes: &'a [u8],
    offset: usize,
    target: GoTarget<'a>,
}

impl<'a> BuildExpression<'a> {
    fn parse(source: &'a str, target: GoTarget<'a>) -> Truth {
        let mut parser = Self {
            bytes: source.as_bytes(),
            offset: 0,
            target,
        };
        let value = parser.parse_or(0);
        parser.skip_space();
        if parser.offset == parser.bytes.len() {
            value.unwrap_or(Truth::Unknown)
        } else {
            Truth::Unknown
        }
    }

    fn parse_or(&mut self, depth: usize) -> Option<Truth> {
        let mut value = self.parse_and(depth)?;
        loop {
            self.skip_space();
            if !self.consume(b"||") {
                return Some(value);
            }
            value = value.or(self.parse_and(depth)?);
        }
    }

    fn parse_and(&mut self, depth: usize) -> Option<Truth> {
        let mut value = self.parse_unary(depth)?;
        loop {
            self.skip_space();
            if !self.consume(b"&&") {
                return Some(value);
            }
            value = value.and(self.parse_unary(depth)?);
        }
    }

    fn parse_unary(&mut self, depth: usize) -> Option<Truth> {
        self.skip_space();
        if self.consume(b"!") {
            return Some(self.parse_unary(depth)?.not());
        }
        if self.consume(b"(") {
            if depth >= MAX_STRUCTURAL_DEPTH {
                return None;
            }
            let value = self.parse_or(depth.saturating_add(1))?;
            self.skip_space();
            return self.consume(b")").then_some(value);
        }
        self.parse_tag()
    }

    fn parse_tag(&mut self) -> Option<Truth> {
        self.skip_space();
        let start = self.offset;
        while self
            .bytes
            .get(self.offset)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.'))
        {
            self.offset = self.offset.saturating_add(1);
        }
        (self.offset > start).then(|| evaluate_tag(&self.bytes[start..self.offset], self.target))
    }

    fn skip_space(&mut self) {
        while self
            .bytes
            .get(self.offset)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.offset = self.offset.saturating_add(1);
        }
    }

    fn consume(&mut self, token: &[u8]) -> bool {
        if self
            .bytes
            .get(self.offset..)
            .is_some_and(|rest| rest.starts_with(token))
        {
            self.offset = self.offset.saturating_add(token.len());
            true
        } else {
            false
        }
    }
}

fn evaluate_legacy(lines: &[&str], target: GoTarget<'_>) -> Truth {
    lines.iter().fold(Truth::True, |all_lines, line| {
        let any_option = line
            .split_ascii_whitespace()
            .fold(Truth::False, |any, option| {
                let all_terms = option.split(',').fold(Truth::True, |all, term| {
                    let (negated, tag) = term
                        .strip_prefix('!')
                        .map_or((false, term), |tag| (true, tag));
                    let value = evaluate_tag(tag.as_bytes(), target);
                    all.and(if negated { value.not() } else { value })
                });
                any.or(all_terms)
            });
        all_lines.and(any_option)
    })
}

fn evaluate_tag(tag: &[u8], target: GoTarget<'_>) -> Truth {
    let Ok(tag) = std::str::from_utf8(tag) else {
        return Truth::Unknown;
    };
    if tag == target.os || tag == target.arch {
        Truth::True
    } else if known_go_os(tag) || known_go_arch(tag) {
        Truth::False
    } else if tag == "unix" {
        Truth::from_bool(unix_go_os(target.os))
    } else {
        Truth::Unknown
    }
}

impl Truth {
    const fn from_bool(value: bool) -> Self {
        if value { Self::True } else { Self::False }
    }
}

fn filename_constraint(file: &SourceFile, target: GoTarget<'_>) -> Option<bool> {
    let filename = file.path.as_utf8()?.rsplit('/').next()?;
    let mut stem = filename.strip_suffix(".go")?;
    if target.test {
        stem = stem.strip_suffix("_test")?;
    }
    let parts = stem.rsplit('_').take(3).collect::<Vec<_>>();
    let first = *parts.first()?;
    if known_go_arch(first) {
        return Some(architecture_constraint(&parts, target, first));
    }
    known_go_os(first).then_some(first == target.os)
}

fn architecture_constraint(parts: &[&str], target: GoTarget<'_>, arch: &str) -> bool {
    if let Some(os) = parts.get(1).copied().filter(|value| known_go_os(value)) {
        os == target.os && arch == target.arch
    } else {
        arch == target.arch
    }
}

fn known_go_os(value: &str) -> bool {
    matches!(
        value,
        "aix"
            | "android"
            | "darwin"
            | "dragonfly"
            | "freebsd"
            | "hurd"
            | "illumos"
            | "ios"
            | "js"
            | "linux"
            | "netbsd"
            | "openbsd"
            | "plan9"
            | "solaris"
            | "wasip1"
            | "windows"
    )
}

fn unix_go_os(value: &str) -> bool {
    matches!(
        value,
        "aix"
            | "android"
            | "darwin"
            | "dragonfly"
            | "freebsd"
            | "hurd"
            | "illumos"
            | "ios"
            | "linux"
            | "netbsd"
            | "openbsd"
            | "solaris"
    )
}

fn known_go_arch(value: &str) -> bool {
    matches!(
        value,
        "386"
            | "amd64"
            | "arm"
            | "arm64"
            | "loong64"
            | "mips"
            | "mips64"
            | "mips64le"
            | "mipsle"
            | "ppc64"
            | "ppc64le"
            | "riscv64"
            | "s390x"
            | "wasm"
    )
}

pub(super) fn syntax_diagnostics(
    root: Node<'_>,
    source: &[u8],
    lines: &LineIndex,
    target: GoTarget<'_>,
    cancel: &CancelToken,
) -> Result<Vec<RawDiagnostic>, AnalysisError> {
    if !root.has_error() {
        return Ok(Vec::new());
    }
    let mut collector = SyntaxCollector::new(source, lines, target);
    walk::walk(root, cancel, |event| Ok(collector.observe(event)))?;
    Ok(collector.finish())
}

struct SyntaxCollector<'a> {
    source: &'a [u8],
    lines: &'a LineIndex,
    target: GoTarget<'a>,
    diagnostics: Vec<RawDiagnostic>,
    total: usize,
    occurrences: BTreeMap<String, usize>,
}

impl<'a> SyntaxCollector<'a> {
    fn new(source: &'a [u8], lines: &'a LineIndex, target: GoTarget<'a>) -> Self {
        Self {
            source,
            lines,
            target,
            diagnostics: Vec::new(),
            total: 0,
            occurrences: BTreeMap::new(),
        }
    }

    fn observe(&mut self, event: walk::WalkEvent<'_>) -> bool {
        let walk::WalkEvent::Enter(node) = event else {
            return true;
        };
        if !node.is_error() && !node.is_missing() {
            return true;
        }
        self.total = self.total.saturating_add(1);
        if self.diagnostics.len() < MAX_DIAGNOSTICS.saturating_sub(1) {
            self.push(node);
        }
        !node.is_error()
    }

    fn push(&mut self, node: Node<'_>) {
        let message = syntax_message(node);
        let anchor = crate::analysis::line_anchor(self.source, node.start_byte());
        let key = format!("{message}:{anchor}");
        let occurrence = self.occurrences.entry(key).or_default();
        let entity_key = format!("syntax:{message}:{anchor}:{}", *occurrence);
        *occurrence = occurrence.saturating_add(1);
        let mut evidence = parser_evidence();
        evidence.insert("errorKind".into(), serde_json::json!(node.kind()));
        evidence.insert("goos".into(), serde_json::json!(self.target.os));
        evidence.insert("goarch".into(), serde_json::json!(self.target.arch));
        self.diagnostics.push(RawDiagnostic {
            rule_id: "go.syntax".into(),
            severity: Severity::Error,
            message: format!("Invalid Go syntax: {message}"),
            range: Some(self.lines.byte_range(node.start_byte(), node.end_byte())),
            entity_key,
            cause_key: format!("parser:{GO_GRAMMAR_VERSION}:{message}"),
            evidence,
        });
    }

    fn finish(mut self) -> Vec<RawDiagnostic> {
        if self.total > self.diagnostics.len() {
            let retained = self.diagnostics.len();
            let mut evidence = parser_evidence();
            evidence.insert("actual".into(), serde_json::json!(self.total));
            evidence.insert("retained".into(), serde_json::json!(retained));
            evidence.insert("truncated".into(), serde_json::json!(true));
            self.diagnostics.push(RawDiagnostic {
                rule_id: "go.syntax".into(),
                severity: Severity::Error,
                message: format!(
                    "Go parser produced {} errors; only the first {retained} are reported",
                    self.total
                ),
                range: None,
                entity_key: "syntax:truncated".into(),
                cause_key: format!("parser:{GO_GRAMMAR_VERSION}:truncated"),
                evidence,
            });
        }
        self.diagnostics
    }
}

fn syntax_message(node: Node<'_>) -> String {
    if node.is_missing() {
        format!("missing {}", node.kind())
    } else {
        "unexpected or invalid syntax".into()
    }
}

pub(super) fn invalid_utf8_facts(
    source: &[u8],
    lines: &LineIndex,
    error: std::str::Utf8Error,
    target: GoTarget<'_>,
) -> FileFacts {
    let mut evidence = parser_evidence();
    evidence.insert("errorKind".into(), serde_json::json!("invalid_utf8"));
    evidence.insert("goos".into(), serde_json::json!(target.os));
    evidence.insert("goarch".into(), serde_json::json!(target.arch));
    parser_failed_facts(vec![shared_invalid_utf8_diagnostic(
        InvalidUtf8Diagnostic {
            language: "Go",
            rule_id: "go.syntax",
            source,
            lines,
            error,
            evidence,
        },
    )])
}

pub(super) fn parser_failed_facts(diagnostics: Vec<RawDiagnostic>) -> FileFacts {
    parser_failure_facts(PARSER_NAME, GO_GRAMMAR_VERSION, diagnostics)
}

pub(super) fn parser_evidence() -> std::collections::BTreeMap<String, serde_json::Value> {
    let mut evidence = base_parser_evidence(PARSER_NAME, GO_GRAMMAR_VERSION);
    evidence.insert(
        "parserRuntimeVersion".into(),
        serde_json::json!(GO_RUNTIME_VERSION),
    );
    evidence
}

#[derive(Default)]
struct Structure {
    delimiters: usize,
    unary: usize,
    expression_nodes: usize,
    brace_expressions: Vec<usize>,
}

impl Structure {
    fn token(&mut self, token: &[u8]) -> Result<(), AnalysisError> {
        if matches!(token, b"(" | b"[") {
            self.open_expression();
        } else if token == b"{" {
            self.open_brace();
        } else if matches!(token, b")" | b"]") {
            self.close_expression();
        } else if token == b"}" {
            self.close_brace();
        } else if matches!(token, b";" | b",") {
            self.statement_boundary();
        } else if unary_operator(token) {
            self.unary_operator();
        } else if expression_operator(token) {
            self.expression_operator();
        } else {
            self.unary = 0;
        }
        self.validate()
    }

    fn open_expression(&mut self) {
        self.delimiters = self.delimiters.saturating_add(1);
        self.expression_nodes = self.expression_nodes.saturating_add(1);
        self.unary = 0;
    }

    fn open_brace(&mut self) {
        self.delimiters = self.delimiters.saturating_add(1);
        self.brace_expressions.push(self.expression_nodes);
        self.expression_nodes = 0;
        self.unary = 0;
    }

    fn close_expression(&mut self) {
        self.delimiters = self.delimiters.saturating_sub(1);
        self.unary = 0;
    }

    fn close_brace(&mut self) {
        self.delimiters = self.delimiters.saturating_sub(1);
        self.expression_nodes = self.brace_expressions.pop().unwrap_or(0);
        self.unary = 0;
    }

    fn unary_operator(&mut self) {
        self.expression_nodes = self.expression_nodes.saturating_add(1);
        self.unary = self.unary.saturating_add(1);
    }

    fn expression_operator(&mut self) {
        self.expression_nodes = self.expression_nodes.saturating_add(1);
        self.unary = 0;
    }

    fn statement_boundary(&mut self) {
        self.unary = 0;
        self.expression_nodes = 0;
    }

    fn validate(&self) -> Result<(), AnalysisError> {
        if self.delimiters > MAX_STRUCTURAL_DEPTH
            || self.unary > MAX_STRUCTURAL_DEPTH
            || self.expression_nodes > MAX_STRUCTURAL_DEPTH
        {
            return Err(AnalysisError::Unsupported(format!(
                "Go source structural depth exceeds the {MAX_STRUCTURAL_DEPTH}-level safety limit"
            )));
        }
        Ok(())
    }
}

fn unary_operator(token: &[u8]) -> bool {
    matches!(token, b"!" | b"^" | b"+" | b"-" | b"*" | b"&" | b"<-")
}

fn expression_operator(token: &[u8]) -> bool {
    matches!(
        token,
        b"." | b"&&"
            | b"||"
            | b"=="
            | b"!="
            | b"<"
            | b">"
            | b"<="
            | b">="
            | b"/"
            | b"%"
            | b"|"
            | b"<<"
            | b">>"
            | b"&^"
    )
}

struct Scanner<'a> {
    source: &'a str,
    bytes: &'a [u8],
    index: usize,
    tokens: Vec<GoToken>,
    structure: Structure,
    can_insert_semicolon: bool,
}

impl<'a> Scanner<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source,
            bytes: source.as_bytes(),
            index: 0,
            tokens: Vec::with_capacity(source.len().saturating_div(4)),
            structure: Structure::default(),
            can_insert_semicolon: false,
        }
    }

    fn scan(mut self, cancel: &CancelToken) -> Result<Vec<GoToken>, AnalysisError> {
        let mut scanned = 0usize;
        while self.index < self.bytes.len() {
            scanned = scanned.saturating_add(1);
            if scanned.is_multiple_of(CANCELLATION_POLL_INTERVAL) {
                walk::check_cancel(cancel)?;
            }
            if self.advance_trivia() {
                continue;
            }
            self.advance_significant()?;
        }
        walk::check_cancel(cancel)?;
        Ok(self.tokens)
    }

    fn advance_trivia(&mut self) -> bool {
        match self.bytes[self.index] {
            b' ' | b'\t' | 0x0c => self.index = self.index.saturating_add(1),
            b'\r' | b'\n' => {
                let newline = self.index;
                self.index = consume_newline(self.bytes, self.index);
                self.record_newline(newline);
            }
            b'/' if self.bytes.get(self.index + 1) == Some(&b'/') => {
                self.index = line_end(self.bytes, self.index);
            }
            b'/' if self.bytes.get(self.index + 1) == Some(&b'*') => {
                let (end, newline) =
                    consume_block_comment(self.bytes, self.index.saturating_add(2));
                self.index = end;
                if let Some(newline) = newline {
                    self.record_newline(newline);
                }
            }
            _ => return false,
        }
        true
    }

    fn advance_significant(&mut self) -> Result<(), AnalysisError> {
        let start = self.index;
        let (end, tag, semicolon) = match self.bytes[start] {
            b'"' | b'\'' => (consume_quoted(self.bytes, start), 2, true),
            b'`' => (consume_raw(self.bytes, start), 2, true),
            byte if identifier_start(byte) => self.identifier(start),
            byte if byte.is_ascii_digit() => (consume_number(self.bytes, start), 2, true),
            _ => self.operator(start),
        };
        self.index = end;
        self.push(start, end, tag)?;
        self.can_insert_semicolon = semicolon;
        Ok(())
    }

    fn identifier(&self, start: usize) -> (usize, u8, bool) {
        let end = consume_identifier(self.source, start);
        let text = self.bytes.get(start..end).unwrap_or_default();
        let keyword = is_keyword(text);
        let semicolon =
            !keyword || matches!(text, b"break" | b"continue" | b"fallthrough" | b"return");
        (end, if keyword { 3 } else { 1 }, semicolon)
    }

    fn operator(&self, start: usize) -> (usize, u8, bool) {
        let end = consume_operator(self.bytes, start);
        let text = self.bytes.get(start..end).unwrap_or_default();
        (end, 4, matches!(text, b")" | b"]" | b"}" | b"++" | b"--"))
    }

    fn push(&mut self, start: usize, end: usize, tag: u8) -> Result<(), AnalysisError> {
        self.structure
            .token(self.bytes.get(start..end).unwrap_or_default())?;
        self.tokens.push(GoToken {
            start,
            end,
            tag,
            counted: true,
            synthetic_newline: false,
        });
        Ok(())
    }

    fn record_newline(&mut self, position: usize) {
        if !self.can_insert_semicolon {
            return;
        }
        self.tokens.push(GoToken {
            start: position,
            end: position,
            tag: 4,
            counted: false,
            synthetic_newline: true,
        });
        self.structure.statement_boundary();
        self.can_insert_semicolon = false;
    }
}

pub(super) fn scan_tokens(
    source: &str,
    cancel: &CancelToken,
) -> Result<Vec<GoToken>, AnalysisError> {
    Scanner::new(source).scan(cancel)
}

fn consume_newline(source: &[u8], index: usize) -> usize {
    if source.get(index..index.saturating_add(2)) == Some(b"\r\n") {
        index.saturating_add(2)
    } else {
        index.saturating_add(1)
    }
}

fn line_end(source: &[u8], index: usize) -> usize {
    source[index..]
        .iter()
        .position(|byte| matches!(byte, b'\r' | b'\n'))
        .map_or(source.len(), |offset| index.saturating_add(offset))
}

fn consume_block_comment(source: &[u8], mut index: usize) -> (usize, Option<usize>) {
    let mut newline = None;
    while index < source.len() {
        if source.get(index..index.saturating_add(2)) == Some(b"*/") {
            return (index.saturating_add(2), newline);
        }
        if newline.is_none() && matches!(source[index], b'\r' | b'\n') {
            newline = Some(index);
        }
        index = index.saturating_add(1);
    }
    (source.len(), newline)
}

fn consume_quoted(source: &[u8], mut index: usize) -> usize {
    let quote = source[index];
    index = index.saturating_add(1);
    while index < source.len() {
        match source[index] {
            b'\\' => index = index.saturating_add(2).min(source.len()),
            byte if byte == quote => return index.saturating_add(1),
            b'\r' | b'\n' => return index,
            _ => index = index.saturating_add(1),
        }
    }
    source.len()
}

fn consume_raw(source: &[u8], mut index: usize) -> usize {
    index = index.saturating_add(1);
    while index < source.len() {
        if source[index] == b'`' {
            return index.saturating_add(1);
        }
        index = index.saturating_add(1);
    }
    source.len()
}

fn consume_identifier(source: &str, start: usize) -> usize {
    let mut end = start;
    for (offset, character) in source.get(start..).unwrap_or_default().char_indices() {
        if !identifier_character(character, offset == 0) {
            break;
        }
        end = start
            .saturating_add(offset)
            .saturating_add(character.len_utf8());
    }
    end.max(start.saturating_add(1))
}

fn identifier_character(character: char, first: bool) -> bool {
    character == '_' || character.is_alphabetic() || (!first && character.is_numeric())
}

fn consume_number(source: &[u8], mut index: usize) -> usize {
    while source
        .get(index)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.'))
    {
        index = index.saturating_add(1);
    }
    index
}

fn consume_operator(source: &[u8], index: usize) -> usize {
    for width in [3usize, 2] {
        if source
            .get(index..index.saturating_add(width))
            .is_some_and(is_multi_operator)
        {
            return index.saturating_add(width);
        }
    }
    index.saturating_add(1)
}

fn is_multi_operator(token: &[u8]) -> bool {
    matches!(
        token,
        b"..."
            | b"<<="
            | b">>="
            | b"&^="
            | b"++"
            | b"--"
            | b"=="
            | b"!="
            | b"<="
            | b">="
            | b"&&"
            | b"||"
            | b"<-"
            | b":="
            | b"<<"
            | b">>"
            | b"&^"
            | b"+="
            | b"-="
            | b"*="
            | b"/="
            | b"%="
            | b"&="
            | b"|="
            | b"^="
    )
}

fn identifier_start(byte: u8) -> bool {
    byte == b'_' || byte.is_ascii_alphabetic() || !byte.is_ascii()
}

fn is_keyword(token: &[u8]) -> bool {
    matches!(
        token,
        b"break"
            | b"default"
            | b"func"
            | b"interface"
            | b"select"
            | b"case"
            | b"defer"
            | b"go"
            | b"map"
            | b"struct"
            | b"chan"
            | b"else"
            | b"goto"
            | b"package"
            | b"switch"
            | b"const"
            | b"fallthrough"
            | b"if"
            | b"range"
            | b"type"
            | b"continue"
            | b"for"
            | b"import"
            | b"return"
            | b"var"
    )
}

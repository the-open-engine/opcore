use std::collections::BTreeMap;

use ruff_python_ast::{
    self as ast,
    token::{TokenKind, Tokens},
    visitor::{Visitor, walk_elif_else_clause, walk_expr, walk_stmt},
};
use ruff_python_parser::{LexicalErrorType, ParseErrorType, parse_module};
use ruff_text_size::{Ranged, TextRange, TextSize};

use crate::{
    analysis::{
        AnalysisError, PYTHON_PARSER_VERSION,
        dedup::{FingerprintCollector, FingerprintToken, fingerprint, region_fingerprints},
        parser_evidence as base_parser_evidence, parser_failure_facts,
    },
    cancel::CancelToken,
    limits::{MAX_DEPENDENCY_FACTS_PER_FILE, MAX_INTERFACE_FACTS_PER_FILE, RuleLimits},
    model::{
        CallableFingerprintFacts, CallableKind as FingerprintCallableKind,
        DependencyExtractionStatus, DependencyFacts, DependencyReference, DependencyReferenceKind,
        FileFacts, InterfaceDeclarationKind, InterfaceExportFact, InterfaceExportNamespace,
        InterfaceExportOrigin, InterfaceExtractionStatus, InterfaceFacts, InterfaceImportFact,
        InterfaceImportRole, InterfaceNamespace, InterfaceSelector, InterfaceSelectorKind,
        InterfaceSurfaceStatus, Position, RawDiagnostic, RegionFingerprintFacts, Severity,
        SourceFile, SourceRange,
    },
};

mod input;

#[cfg(test)]
use input::UTF8_BOM;
use input::{PythonFingerprintToken, decode_source, fingerprint_tokens, preflight_structure};

const PARSER_NAME: &str = "ruff-python-parser";
pub fn analyze(
    file: &SourceFile,
    limits: &RuleLimits,
    cancel: &CancelToken,
) -> Result<FileFacts, AnalysisError> {
    cancellation_boundary(cancel)?;
    let decoded = decode_source(&file.bytes)?;
    cancellation_boundary(cancel)?;
    preflight_structure(decoded.text, cancel)?;

    let lines = LineMap::new(decoded.text, decoded.byte_base);
    let parsed = match parse_module(decoded.text) {
        Ok(parsed) => parsed,
        Err(error) => {
            let diagnostic = parse_diagnostic(
                error.location.start(),
                parse_error_kind(&error.error),
                parse_error_message(&error.error),
                &lines,
            );
            return Ok(parser_failure_facts(
                PARSER_NAME,
                PYTHON_PARSER_VERSION,
                vec![diagnostic],
            ));
        }
    };
    cancellation_boundary(cancel)?;

    let fingerprint_tokens = fingerprint_tokens(parsed.tokens());
    let region_fingerprints = python_region_fingerprints(&fingerprint_tokens, decoded.text, &lines);
    let interfaces = python_interface_exports(&parsed.syntax().body, decoded.text, parsed.tokens());
    let mut walker = MetricsWalker::new(limits, cancel, &lines, &fingerprint_tokens, interfaces);
    walker.visit_body(&parsed.syntax().body);
    if walker.cancelled {
        return Err(AnalysisError::Cancelled);
    }
    cancellation_boundary(cancel)?;
    walker.diagnostics.sort_by(|left, right| {
        left.range
            .map(|range| (range.start.byte, range.end.byte))
            .cmp(&right.range.map(|range| (range.start.byte, range.end.byte)))
            .then_with(|| left.rule_id.cmp(&right.rule_id))
            .then_with(|| left.entity_key.cmp(&right.entity_key))
    });

    let dependencies = walker.take_dependency_facts();
    let callable_fingerprints = walker.take_callable_fingerprints();
    let interfaces = walker.take_interface_facts();
    Ok(FileFacts {
        diagnostics: walker.diagnostics,
        parser: PARSER_NAME.into(),
        parser_version: PYTHON_PARSER_VERSION.into(),
        dependencies,
        callable_fingerprints,
        region_fingerprints,
        interfaces,
    })
}

fn parse_diagnostic(
    offset: TextSize,
    error_kind: &'static str,
    message: &'static str,
    lines: &LineMap<'_>,
) -> RawDiagnostic {
    let start = offset.to_usize().min(lines.source.len());
    let width = lines.source[start..]
        .chars()
        .next()
        .map_or(0, char::len_utf8);
    let mut evidence = parser_evidence();
    evidence.insert("errorKind".into(), serde_json::json!(error_kind));
    RawDiagnostic {
        rule_id: "python.syntax".into(),
        severity: Severity::Error,
        message: message.into(),
        range: Some(lines.range(start, start.saturating_add(width))),
        entity_key: format!(
            "module-syntax:{error_kind}:{}",
            crate::analysis::line_anchor(lines.source.as_bytes(), start)
        ),
        cause_key: error_kind.into(),
        evidence,
    }
}

const fn parse_error_kind(error: &ParseErrorType) -> &'static str {
    match error {
        ParseErrorType::UnexpectedIndentation => "indentation",
        ParseErrorType::FStringError(_) => "f-string",
        ParseErrorType::TStringError(_) => "t-string",
        ParseErrorType::RecursionLimitExceeded => "recursion-limit",
        ParseErrorType::ExpectedToken { found, .. } if found.is_eof() => "unexpected-eof",
        ParseErrorType::Lexical(error) => lexical_error_kind(error),
        _ => "syntax",
    }
}

const fn lexical_error_kind(error: &LexicalErrorType) -> &'static str {
    match error {
        LexicalErrorType::StringError | LexicalErrorType::UnclosedStringError => "string",
        LexicalErrorType::UnicodeError
        | LexicalErrorType::MissingUnicodeLbrace
        | LexicalErrorType::MissingUnicodeRbrace => "unicode",
        _ => lexical_misc_error_kind(error),
    }
}

const fn lexical_misc_error_kind(error: &LexicalErrorType) -> &'static str {
    match error {
        LexicalErrorType::IndentationError => "indentation",
        LexicalErrorType::UnrecognizedToken { .. } => "unrecognized-token",
        LexicalErrorType::FStringError(_) => "f-string",
        LexicalErrorType::TStringError(_) => "t-string",
        LexicalErrorType::Eof => "unexpected-eof",
        LexicalErrorType::LineContinuationError => "line-continuation",
        LexicalErrorType::InvalidByteLiteral => "byte-literal",
        _ => "lexer",
    }
}

const fn parse_error_message(error: &ParseErrorType) -> &'static str {
    match error {
        ParseErrorType::ExpectedToken { found, .. } if found.is_eof() => {
            "unexpected end of Python source"
        }
        ParseErrorType::UnexpectedIndentation => "unexpected Python indentation",
        ParseErrorType::Lexical(error) => lexical_error_message(error),
        ParseErrorType::FStringError(_) => "invalid Python f-string",
        ParseErrorType::TStringError(_) => "invalid Python t-string",
        ParseErrorType::RecursionLimitExceeded => "Python syntax exceeds the parser depth limit",
        _ => "invalid Python syntax",
    }
}

const fn lexical_error_message(error: &LexicalErrorType) -> &'static str {
    match error {
        LexicalErrorType::IndentationError => "Python indentation does not match an outer level",
        LexicalErrorType::FStringError(_) => "invalid Python f-string",
        LexicalErrorType::TStringError(_) => "invalid Python t-string",
        _ => "invalid Python syntax",
    }
}

fn parser_evidence() -> BTreeMap<String, serde_json::Value> {
    base_parser_evidence(PARSER_NAME, PYTHON_PARSER_VERSION)
}

struct LineMap<'a> {
    source: &'a str,
    starts: Vec<usize>,
    byte_base: usize,
}

impl<'a> LineMap<'a> {
    fn new(source: &'a str, byte_base: usize) -> Self {
        let bytes = source.as_bytes();
        let mut starts = vec![0];
        let mut index = 0;
        while index < bytes.len() {
            match bytes[index] {
                b'\r' => {
                    index += 1;
                    if bytes.get(index) == Some(&b'\n') {
                        index += 1;
                    }
                    starts.push(index);
                }
                b'\n' => {
                    index += 1;
                    starts.push(index);
                }
                _ => index += 1,
            }
        }
        Self {
            source,
            starts,
            byte_base,
        }
    }

    fn position_usize(&self, offset: usize) -> Position {
        let offset = offset.min(self.source.len());
        let line_index = self
            .starts
            .partition_point(|start| *start <= offset)
            .saturating_sub(1);
        let line_start = self.starts[line_index];
        Position {
            line: u32::try_from(line_index.saturating_add(1)).unwrap_or(u32::MAX),
            column: u32::try_from(offset.saturating_sub(line_start).saturating_add(1))
                .unwrap_or(u32::MAX),
            byte: u32::try_from(offset.saturating_add(self.byte_base)).unwrap_or(u32::MAX),
        }
    }

    fn range(&self, start: usize, end: usize) -> SourceRange {
        SourceRange {
            start: self.position_usize(start),
            end: self.position_usize(end),
        }
    }

    fn text_range(&self, range: TextRange) -> SourceRange {
        self.range(range.start().to_usize(), range.end().to_usize())
    }

    fn line_span(&self, range: TextRange) -> u32 {
        let start = range.start().to_usize();
        let end = range.end().to_usize();
        let start_line = self.position_usize(start).line;
        let end_line = self.position_usize(end.saturating_sub(1).max(start)).line;
        end_line.saturating_sub(start_line).saturating_add(1)
    }
}

#[derive(Clone, Copy)]
enum CallableKind {
    Function,
    AsyncFunction,
    Lambda,
}

impl CallableKind {
    const fn label(self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::AsyncFunction => "async function",
            Self::Lambda => "lambda",
        }
    }
}

struct FunctionMetrics {
    kind: CallableKind,
    entity: String,
    range: TextRange,
    parameters: u32,
    complexity: u32,
    control_depth: u32,
    max_nesting: u32,
}

struct MetricsWalker<'a> {
    limits: &'a RuleLimits,
    cancel: &'a CancelToken,
    lines: &'a LineMap<'a>,
    frames: Vec<Option<FunctionMetrics>>,
    scope: Vec<String>,
    entity_occurrences: BTreeMap<String, u32>,
    diagnostics: Vec<RawDiagnostic>,
    dependencies: Vec<DependencyReference>,
    dependencies_truncated: bool,
    fingerprint_tokens: &'a [PythonFingerprintToken],
    fingerprints: FingerprintCollector,
    interfaces: InterfaceFacts,
    interfaces_truncated: bool,
    cancelled: bool,
}

impl<'a> MetricsWalker<'a> {
    fn new(
        limits: &'a RuleLimits,
        cancel: &'a CancelToken,
        lines: &'a LineMap<'a>,
        fingerprint_tokens: &'a [PythonFingerprintToken],
        interfaces: InterfaceFacts,
    ) -> Self {
        Self {
            limits,
            cancel,
            lines,
            frames: Vec::new(),
            scope: Vec::new(),
            entity_occurrences: BTreeMap::new(),
            diagnostics: Vec::new(),
            dependencies: Vec::new(),
            dependencies_truncated: false,
            fingerprint_tokens,
            fingerprints: FingerprintCollector::default(),
            interfaces,
            interfaces_truncated: false,
            cancelled: false,
        }
    }

    fn current(&mut self) -> Option<&mut FunctionMetrics> {
        self.frames.last_mut().and_then(Option::as_mut)
    }

    fn stop_requested(&mut self) -> bool {
        self.cancelled |= self.cancel.is_cancelled();
        self.cancelled
    }

    fn enter_control(&mut self, complexity: u32) -> Option<u32> {
        let current = self.current()?;
        current.complexity = current.complexity.saturating_add(complexity);
        let previous = current.control_depth;
        current.control_depth = current.control_depth.saturating_add(1);
        current.max_nesting = current.max_nesting.max(current.control_depth);
        Some(previous)
    }

    fn leave_control(&mut self, previous: Option<u32>) {
        if let (Some(previous), Some(current)) = (previous, self.current()) {
            current.control_depth = previous;
        }
    }

    fn add_complexity(&mut self, amount: usize) {
        if let Some(current) = self.current() {
            current.complexity = current
                .complexity
                .saturating_add(u32::try_from(amount).unwrap_or(u32::MAX));
        }
    }

    fn enter_callable(
        &mut self,
        kind: CallableKind,
        name: String,
        range: TextRange,
        parameters: u32,
    ) {
        self.scope.push(name);
        let base_entity = format!("callable:{}", self.scope.join("."));
        let occurrence = self
            .entity_occurrences
            .entry(base_entity.clone())
            .or_default();
        let entity = format!("{base_entity}:{}", *occurrence);
        *occurrence = occurrence.saturating_add(1);
        self.frames.push(Some(FunctionMetrics {
            kind,
            entity,
            range,
            parameters,
            complexity: 1,
            control_depth: 0,
            max_nesting: 0,
        }));
    }

    fn observe_callable_fingerprint(
        &mut self,
        kind: FingerprintCallableKind,
        range: Option<TextRange>,
    ) {
        if self.frames.iter().any(Option::is_some) {
            return;
        }
        let Some(range) = range else {
            return;
        };
        let start = range.start().to_usize();
        let end = range.end().to_usize();
        let source = self.lines.source.as_bytes();
        let output_range = self.lines.text_range(range);
        self.fingerprints.push(fingerprint(
            "python",
            kind,
            output_range,
            self.fingerprint_tokens
                .iter()
                .filter(|token| token.start >= start && token.end <= end)
                .map(|token| FingerprintToken {
                    tag: token.tag,
                    text: source.get(token.start..token.end).unwrap_or_default(),
                    line: self.lines.position_usize(token.start).line,
                    counted: token.tag == 0,
                    start_byte: self.lines.position_usize(token.start).byte,
                    end_byte: self.lines.position_usize(token.end).byte,
                }),
        ));
    }

    fn leave_callable(&mut self) {
        let metrics = self.frames.pop().flatten();
        self.scope.pop();
        if let Some(metrics) = metrics {
            self.emit_metrics(&metrics);
        }
    }

    fn emit_metrics(&mut self, metrics: &FunctionMetrics) {
        let function_lines = self.lines.line_span(metrics.range);
        self.emit_metric(
            metrics,
            "complexity.max-function-lines",
            "functionLines",
            function_lines,
            self.limits.max_function_lines,
        );
        self.emit_metric(
            metrics,
            "complexity.max-parameters",
            "parameters",
            metrics.parameters,
            self.limits.max_parameters,
        );
        self.emit_metric(
            metrics,
            "complexity.max-nesting",
            "nesting",
            metrics.max_nesting,
            self.limits.max_nesting,
        );
        self.emit_metric(
            metrics,
            "complexity.max-cyclomatic-complexity",
            "cyclomaticComplexity",
            metrics.complexity,
            self.limits.max_cyclomatic_complexity,
        );
    }

    fn emit_metric(
        &mut self,
        metrics: &FunctionMetrics,
        rule_id: &str,
        metric_name: &str,
        actual: u32,
        limit: u32,
    ) {
        if actual <= limit {
            return;
        }
        let mut evidence = parser_evidence();
        evidence.insert("metric".into(), serde_json::json!(metric_name));
        evidence.insert("actual".into(), serde_json::json!(actual));
        evidence.insert("limit".into(), serde_json::json!(limit));
        self.diagnostics.push(RawDiagnostic {
            rule_id: rule_id.into(),
            severity: Severity::Warning,
            message: format!(
                "{} has {actual} {metric_name}; configured maximum is {limit}",
                metrics.kind.label()
            ),
            range: Some(self.lines.text_range(metrics.range)),
            entity_key: metrics.entity.clone(),
            cause_key: format!("limit:{limit}"),
            evidence,
        });
    }

    fn enter_comprehension(&mut self, generators: &[ast::Comprehension]) -> Option<u32> {
        let decisions = generators
            .len()
            .saturating_add(generators.iter().map(|generator| generator.ifs.len()).sum());
        let current = self.current()?;
        current.complexity = current
            .complexity
            .saturating_add(u32::try_from(decisions).unwrap_or(u32::MAX));
        let previous = current.control_depth;
        current.control_depth = current
            .control_depth
            .saturating_add(u32::try_from(generators.len()).unwrap_or(u32::MAX));
        current.max_nesting = current.max_nesting.max(current.control_depth);
        Some(previous)
    }

    fn enter_expression_control(&mut self, expression: &ast::Expr) -> Option<u32> {
        match expression {
            ast::Expr::ListComp(node) => self.enter_comprehension(&node.generators),
            ast::Expr::SetComp(node) => self.enter_comprehension(&node.generators),
            ast::Expr::DictComp(node) => self.enter_comprehension(&node.generators),
            ast::Expr::Generator(node) => self.enter_comprehension(&node.generators),
            _ => None,
        }
    }

    fn push_dependency(
        &mut self,
        kind: DependencyReferenceKind,
        specifier: impl Into<String>,
        level: u32,
    ) {
        if self.dependencies.len() >= MAX_DEPENDENCY_FACTS_PER_FILE {
            self.dependencies_truncated = true;
            return;
        }
        self.dependencies.push(DependencyReference {
            kind,
            specifier: specifier.into(),
            level,
        });
    }

    fn observe_dependency(&mut self, statement: &ast::Stmt) {
        match statement {
            ast::Stmt::Import(import) => {
                for alias in &import.names {
                    self.push_dependency(
                        DependencyReferenceKind::PythonAbsolute,
                        alias.name.to_string(),
                        0,
                    );
                }
            }
            ast::Stmt::ImportFrom(import) => {
                let level = import.level;
                if level == 0 {
                    self.push_dependency(
                        DependencyReferenceKind::PythonAbsolute,
                        import.module.as_ref().map_or("", |module| module.as_str()),
                        0,
                    );
                } else if let Some(module) = &import.module {
                    self.push_dependency(
                        DependencyReferenceKind::PythonRelative,
                        module.to_string(),
                        level,
                    );
                    for alias in &import.names {
                        let selector = if alias.name.as_str() == "*" {
                            self.interfaces.gaps.namespace_imports =
                                self.interfaces.gaps.namespace_imports.saturating_add(1);
                            InterfaceSelector {
                                kind: InterfaceSelectorKind::Namespace,
                                name: String::new(),
                            }
                        } else {
                            InterfaceSelector {
                                kind: InterfaceSelectorKind::Named,
                                name: alias.name.to_string(),
                            }
                        };
                        self.push_interface_import(InterfaceImportFact {
                            specifier: module.to_string(),
                            level,
                            role: InterfaceImportRole::Import,
                            namespace: InterfaceNamespace::Runtime,
                            selector,
                        });
                    }
                } else {
                    self.interfaces.gaps.unsupported_patterns = self
                        .interfaces
                        .gaps
                        .unsupported_patterns
                        .saturating_add(import.names.len());
                    for alias in &import.names {
                        self.push_dependency(
                            DependencyReferenceKind::PythonUnsupportedRelative,
                            alias.name.to_string(),
                            level,
                        );
                    }
                }
            }
            _ => {}
        }
    }

    fn take_dependency_facts(&mut self) -> DependencyFacts {
        self.dependencies.sort();
        DependencyFacts {
            status: if self.dependencies_truncated {
                DependencyExtractionStatus::Truncated
            } else {
                DependencyExtractionStatus::Complete
            },
            references: std::mem::take(&mut self.dependencies),
        }
    }

    fn take_callable_fingerprints(&mut self) -> CallableFingerprintFacts {
        std::mem::take(&mut self.fingerprints).finish()
    }

    fn push_interface_import(&mut self, fact: InterfaceImportFact) {
        let fact_count = self
            .interfaces
            .imports
            .len()
            .saturating_add(self.interfaces.exports.len())
            .saturating_add(self.interfaces.shapes.len());
        if fact_count >= MAX_INTERFACE_FACTS_PER_FILE {
            self.interfaces_truncated = true;
        } else {
            self.interfaces.imports.push(fact);
        }
    }

    fn take_interface_facts(&mut self) -> InterfaceFacts {
        self.interfaces.imports.sort();
        self.interfaces.imports.dedup();
        self.interfaces.exports.sort();
        self.interfaces.exports.dedup();
        self.interfaces.status = if self.interfaces_truncated {
            InterfaceExtractionStatus::Truncated
        } else if self.interfaces.status == InterfaceExtractionStatus::Partial
            || self.interfaces.gaps.namespace_imports > 0
            || self.interfaces.gaps.unsupported_patterns > 0
        {
            InterfaceExtractionStatus::Partial
        } else {
            InterfaceExtractionStatus::Complete
        };
        std::mem::take(&mut self.interfaces)
    }
}

fn python_region_fingerprints(
    tokens: &[PythonFingerprintToken],
    source: &str,
    lines: &LineMap<'_>,
) -> RegionFingerprintFacts {
    region_fingerprints(
        "python",
        tokens.iter().map(|token| FingerprintToken {
            tag: token.tag,
            text: source
                .as_bytes()
                .get(token.start..token.end)
                .unwrap_or_default(),
            line: lines.position_usize(token.start).line,
            counted: token.tag == 0,
            start_byte: lines.position_usize(token.start).byte,
            end_byte: lines.position_usize(token.end).byte,
        }),
    )
}

fn python_interface_exports(suite: &[ast::Stmt], source: &str, tokens: &Tokens) -> InterfaceFacts {
    let occurrences = tokens
        .iter()
        .filter(|token| {
            token.kind() == TokenKind::Name
                && source.get(token.range().to_std_range()) == Some("__all__")
        })
        .count();
    let assignment = suite.iter().find_map(static_all_assignment);
    if occurrences == 0 {
        return InterfaceFacts {
            status: InterfaceExtractionStatus::Complete,
            public_surface_status: InterfaceSurfaceStatus::Unsupported,
            ..InterfaceFacts::default()
        };
    }
    let Some(names) = assignment.filter(|_| occurrences == 1) else {
        return InterfaceFacts {
            status: InterfaceExtractionStatus::Partial,
            public_surface_status: InterfaceSurfaceStatus::Partial,
            gaps: crate::model::InterfaceGapCounts {
                unsupported_patterns: 1,
                ..crate::model::InterfaceGapCounts::default()
            },
            ..InterfaceFacts::default()
        };
    };
    let mut facts = InterfaceFacts {
        status: InterfaceExtractionStatus::Complete,
        public_surface_status: InterfaceSurfaceStatus::Complete,
        ..InterfaceFacts::default()
    };
    let name_count = names.len();
    for name in names.into_iter().take(MAX_INTERFACE_FACTS_PER_FILE) {
        facts.exports.push(InterfaceExportFact {
            exported_name: name,
            namespace: InterfaceExportNamespace::Value,
            origin: InterfaceExportOrigin::Local,
            declaration_kind: InterfaceDeclarationKind::Unknown,
        });
    }
    if facts.exports.len() < name_count {
        facts.status = InterfaceExtractionStatus::Truncated;
        facts.public_surface_status = InterfaceSurfaceStatus::Truncated;
    }
    facts.exports.sort();
    facts.exports.dedup();
    facts
}

fn static_all_assignment(statement: &ast::Stmt) -> Option<Vec<String>> {
    let value = match statement {
        ast::Stmt::Assign(assign)
            if assign.targets.len() == 1 && is_all_name(&assign.targets[0]) =>
        {
            Some(assign.value.as_ref())
        }
        ast::Stmt::AnnAssign(assign) if is_all_name(&assign.target) => assign.value.as_deref(),
        _ => None,
    }?;
    static_string_sequence(value)
}

fn is_all_name(expression: &ast::Expr) -> bool {
    matches!(expression, ast::Expr::Name(name) if name.id.as_str() == "__all__")
}

fn static_string_sequence(expression: &ast::Expr) -> Option<Vec<String>> {
    let elements = match expression {
        ast::Expr::List(list) => &list.elts,
        ast::Expr::Tuple(tuple) => &tuple.elts,
        _ => return None,
    };
    elements
        .iter()
        .map(|element| match element {
            ast::Expr::StringLiteral(literal) => Some(literal.value.to_str().to_owned()),
            _ => None,
        })
        .collect()
}

impl<'ast> Visitor<'ast> for MetricsWalker<'_> {
    fn visit_stmt(&mut self, node: &'ast ast::Stmt) {
        if self.stop_requested() {
            return;
        }
        self.observe_dependency(node);
        match node {
            ast::Stmt::FunctionDef(function) => {
                self.visit_function(function);
                return;
            }
            ast::Stmt::ClassDef(class) => {
                self.scope.push(class.name.to_string());
                self.frames.push(None);
                walk_stmt(self, node);
                self.frames.pop();
                self.scope.pop();
                return;
            }
            _ => {}
        }
        let control = match node {
            ast::Stmt::If(_) | ast::Stmt::For(_) | ast::Stmt::While(_) => self.enter_control(1),
            ast::Stmt::With(_) => self.enter_control(0),
            ast::Stmt::Try(node) => {
                self.enter_control(u32::try_from(node.handlers.len()).unwrap_or(u32::MAX))
            }
            ast::Stmt::Match(node) => {
                self.enter_control(u32::try_from(node.cases.len()).unwrap_or(u32::MAX))
            }
            _ => None,
        };
        walk_stmt(self, node);
        self.leave_control(control);
    }

    fn visit_elif_else_clause(&mut self, clause: &'ast ast::ElifElseClause) {
        if clause.test.is_some() {
            self.add_complexity(1);
        }
        walk_elif_else_clause(self, clause);
    }

    fn visit_expr(&mut self, node: &'ast ast::Expr) {
        if self.stop_requested() {
            return;
        }
        match node {
            ast::Expr::Lambda(lambda) => {
                self.visit_lambda(lambda);
                return;
            }
            ast::Expr::BoolOp(node) => self.add_complexity(node.values.len().saturating_sub(1)),
            ast::Expr::If(_) => self.add_complexity(1),
            _ => {}
        }
        let control = self.enter_expression_control(node);
        walk_expr(self, node);
        self.leave_control(control);
    }
}

impl MetricsWalker<'_> {
    fn visit_function(&mut self, node: &ast::StmtFunctionDef) {
        for decorator in &node.decorator_list {
            self.visit_decorator(decorator);
        }
        if let Some(type_params) = &node.type_params {
            self.visit_type_params(type_params);
        }
        self.visit_parameters(&node.parameters);
        if let Some(returns) = &node.returns {
            self.visit_annotation(returns);
        }
        self.observe_callable_fingerprint(
            FingerprintCallableKind::Function,
            suite_range(&node.body),
        );
        let metric_start = node
            .decorator_list
            .iter()
            .map(Ranged::start)
            .min()
            .unwrap_or_else(|| node.start());
        self.enter_callable(
            if node.is_async {
                CallableKind::AsyncFunction
            } else {
                CallableKind::Function
            },
            node.name.to_string(),
            TextRange::new(metric_start, node.end()),
            parameter_count(&node.parameters),
        );
        self.visit_body(&node.body);
        self.leave_callable();
    }

    fn visit_lambda(&mut self, node: &ast::ExprLambda) {
        self.observe_callable_fingerprint(FingerprintCallableKind::Lambda, Some(node.body.range()));
        let anchor =
            crate::analysis::line_anchor(self.lines.source.as_bytes(), node.start().to_usize());
        self.enter_callable(
            CallableKind::Lambda,
            format!("<lambda:{anchor}>"),
            node.range,
            node.parameters.as_deref().map_or(0, parameter_count),
        );
        if let Some(parameters) = &node.parameters {
            self.visit_parameters(parameters);
        }
        self.visit_expr(&node.body);
        self.leave_callable();
    }
}

fn suite_range(body: &[ast::Stmt]) -> Option<TextRange> {
    Some(TextRange::new(
        body.first().map(Ranged::start)?,
        body.last().map(Ranged::end)?,
    ))
}

fn parameter_count(parameters: &ast::Parameters) -> u32 {
    let count = parameters
        .posonlyargs
        .len()
        .saturating_add(parameters.args.len())
        .saturating_add(parameters.kwonlyargs.len())
        .saturating_add(usize::from(parameters.vararg.is_some()))
        .saturating_add(usize::from(parameters.kwarg.is_some()));
    u32::try_from(count).unwrap_or(u32::MAX)
}

fn cancellation_boundary(cancel: &CancelToken) -> Result<(), AnalysisError> {
    if cancel.is_cancelled() {
        Err(AnalysisError::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{FingerprintExtractionStatus, Language},
        path::RepoPath,
    };

    fn file(bytes: impl Into<Vec<u8>>) -> SourceFile {
        SourceFile::new(
            RepoPath::from_protocol("src/example.py").unwrap(),
            bytes.into(),
            Language::Python,
            "python".into(),
        )
    }

    fn facts(source: &str, limits: &RuleLimits) -> FileFacts {
        analyze(
            &file(source.as_bytes().to_vec()),
            limits,
            &CancelToken::new(),
        )
        .unwrap()
    }

    #[test]
    fn accepts_utf8_bom_and_encoding_cookie() {
        let mut source = UTF8_BOM.to_vec();
        source.extend_from_slice(b"#!/usr/bin/env python\n# coding: utf-8\nvalue = '\xcf\x80'\n");
        let result = analyze(&file(source), &RuleLimits::default(), &CancelToken::new()).unwrap();
        assert!(result.diagnostics.is_empty());
        assert_eq!(result.parser, PARSER_NAME);
        assert_eq!(result.parser_version, PYTHON_PARSER_VERSION);
    }

    #[test]
    fn extracts_only_explicit_relative_dependencies_as_resolvable_facts() {
        let result = facts(
            "import os\nfrom .pkg import value\nfrom ..tools import helper\nfrom . import ambiguous\n",
            &RuleLimits::default(),
        );
        assert_eq!(
            result.dependencies.status,
            DependencyExtractionStatus::Complete
        );
        assert_eq!(
            result.dependencies.references,
            vec![
                DependencyReference {
                    kind: DependencyReferenceKind::PythonRelative,
                    specifier: "pkg".into(),
                    level: 1,
                },
                DependencyReference {
                    kind: DependencyReferenceKind::PythonRelative,
                    specifier: "tools".into(),
                    level: 2,
                },
                DependencyReference {
                    kind: DependencyReferenceKind::PythonUnsupportedRelative,
                    specifier: "ambiguous".into(),
                    level: 1,
                },
                DependencyReference {
                    kind: DependencyReferenceKind::PythonAbsolute,
                    specifier: "os".into(),
                    level: 0,
                },
            ]
        );
    }

    #[test]
    fn extracts_relative_selectors_and_only_exact_static_all_exports() {
        let result = facts(
            "__all__ = ['public_api', 'Shape']\nfrom .api import public_api, Shape as LocalShape\n",
            &RuleLimits::default(),
        );
        assert_eq!(
            result.interfaces.status,
            InterfaceExtractionStatus::Complete
        );
        assert_eq!(
            result.interfaces.public_surface_status,
            InterfaceSurfaceStatus::Complete
        );
        assert_eq!(
            result
                .interfaces
                .exports
                .iter()
                .map(|fact| fact.exported_name.as_str())
                .collect::<Vec<_>>(),
            ["Shape", "public_api"]
        );
        assert_eq!(result.interfaces.imports.len(), 2);
        assert!(result.interfaces.imports.iter().all(|fact| {
            fact.specifier == "api"
                && fact.level == 1
                && fact.selector.kind == InterfaceSelectorKind::Named
        }));
    }

    #[test]
    fn ordinary_python_module_without_all_keeps_selector_coverage_complete() {
        let result = facts("from .api import value\n", &RuleLimits::default());
        assert_eq!(
            result.interfaces.status,
            InterfaceExtractionStatus::Complete
        );
        assert_eq!(
            result.interfaces.public_surface_status,
            InterfaceSurfaceStatus::Unsupported
        );
        assert_eq!(result.interfaces.gaps.unsupported_patterns, 0);
        assert_eq!(result.interfaces.imports.len(), 1);
    }

    #[test]
    fn dynamic_all_and_star_imports_degrade_explicitly() {
        let result = facts(
            "__all__ = make_exports()\nfrom .api import *\n",
            &RuleLimits::default(),
        );
        assert_eq!(result.interfaces.status, InterfaceExtractionStatus::Partial);
        assert_eq!(
            result.interfaces.public_surface_status,
            InterfaceSurfaceStatus::Partial
        );
        assert_eq!(result.interfaces.gaps.namespace_imports, 1);
        assert_eq!(result.interfaces.gaps.unsupported_patterns, 1);
    }

    #[test]
    fn accepts_standard_utf8_cookie_aliases() {
        for alias in ["utf", "u8", "cp65001"] {
            let source = format!("# coding: {alias}\nvalue = '\u{03c0}'\n");
            assert!(
                facts(&source, &RuleLimits::default())
                    .diagnostics
                    .is_empty()
            );
        }
    }

    #[test]
    fn rejects_declared_non_utf8_encoding() {
        let result = analyze(
            &file(b"# coding: latin-1\nname = 'caf\xe9'\n".to_vec()),
            &RuleLimits::default(),
            &CancelToken::new(),
        );
        assert!(
            matches!(result, Err(AnalysisError::Unsupported(message)) if message.contains("latin-1"))
        );
    }

    #[test]
    fn ignores_inline_encoding_like_comments() {
        let result = facts("value = 1  # coding: latin-1\n", &RuleLimits::default());
        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn rejects_undeclared_non_utf8_bytes() {
        let result = analyze(
            &file(b"name = 'caf\xe9'\n".to_vec()),
            &RuleLimits::default(),
            &CancelToken::new(),
        );
        assert!(
            matches!(result, Err(AnalysisError::Unsupported(message)) if message.contains("not valid UTF-8"))
        );
    }

    #[test]
    fn reports_syntax_with_parser_provenance_and_bounded_message() {
        let result = facts("def broken(:\n    pass\n", &RuleLimits::default());
        assert_eq!(result.diagnostics.len(), 1);
        let diagnostic = &result.diagnostics[0];
        assert_eq!(diagnostic.rule_id, "python.syntax");
        assert_eq!(diagnostic.severity, Severity::Error);
        assert_eq!(diagnostic.evidence["parser"], PARSER_NAME);
        assert_eq!(diagnostic.evidence["parserVersion"], PYTHON_PARSER_VERSION);
        assert!(!diagnostic.message.contains("broken"));
        assert!(diagnostic.range.is_some());
    }

    #[test]
    fn emits_function_and_lambda_metrics_deterministically() {
        let source = concat!(
            "def calculate(a, b, *items, **options):\n",
            "    if a and b:\n",
            "        for item in items:\n",
            "            while item:\n",
            "                item -= 1\n",
            "    return lambda left, right: left if left else right\n",
        );
        let limits = RuleLimits {
            max_function_lines: 2,
            max_parameters: 1,
            max_nesting: 1,
            max_cyclomatic_complexity: 2,
            ..RuleLimits::default()
        };
        let first = facts(source, &limits);
        let second = facts(source, &limits);
        assert_eq!(first, second);
        let rules = first
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.rule_id.as_str())
            .collect::<Vec<_>>();
        assert!(rules.contains(&"complexity.max-function-lines"));
        assert!(rules.contains(&"complexity.max-parameters"));
        assert!(rules.contains(&"complexity.max-nesting"));
        assert!(rules.contains(&"complexity.max-cyclomatic-complexity"));
        assert!(first.diagnostics.iter().any(|diagnostic| {
            diagnostic.entity_key.contains("<lambda:")
                && diagnostic.rule_id == "complexity.max-parameters"
        }));
    }

    #[test]
    fn async_functions_and_comprehensions_retain_metric_semantics() {
        let limits = RuleLimits {
            max_cyclomatic_complexity: 1,
            ..RuleLimits::default()
        };
        let result = facts(
            "async def collect(items):\n    return [item async for item in items if item]\n",
            &limits,
        );
        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.rule_id == "complexity.max-cyclomatic-complexity")
            .unwrap();
        assert_eq!(diagnostic.evidence["actual"], 3);
        assert!(diagnostic.message.starts_with("async function"));
    }

    #[test]
    fn callable_fingerprints_ignore_names_and_comments_but_preserve_indentation() {
        use std::fmt::Write as _;

        let mut prefix = String::new();
        for index in 0..16 {
            writeln!(prefix, "    value_{index} = input_value + {index}").unwrap();
        }
        let first = facts(
            &format!("def first(input_value):\n{prefix}    return value_15\n"),
            &RuleLimits::default(),
        );
        let second = facts(
            &format!("def second(input_value):\n{prefix}    return value_15  # ignored comment\n"),
            &RuleLimits::default(),
        );
        assert_eq!(first.callable_fingerprints.callables.len(), 1);
        assert_eq!(
            first.callable_fingerprints.callables[0].digest,
            second.callable_fingerprints.callables[0].digest
        );

        let mut inside = String::new();
        let mut split = String::new();
        for index in 0..16 {
            writeln!(inside, "        value_{index} = input_value + {index}").unwrap();
            let indent = if index < 8 { "        " } else { "    " };
            writeln!(split, "{indent}value_{index} = input_value + {index}").unwrap();
        }
        let nested = facts(
            &format!(
                "def nested(input_value):\n    if input_value:\n{inside}    return value_15\n"
            ),
            &RuleLimits::default(),
        );
        let split = facts(
            &format!("def split(input_value):\n    if input_value:\n{split}    return value_15\n"),
            &RuleLimits::default(),
        );
        assert_ne!(
            nested.callable_fingerprints.callables[0].digest,
            split.callable_fingerprints.callables[0].digest
        );
    }

    #[test]
    fn callable_fingerprints_are_parser_failed_for_invalid_source() {
        let result = facts("def broken(:\n    pass\n", &RuleLimits::default());
        assert_eq!(
            result.callable_fingerprints.status,
            FingerprintExtractionStatus::ParserFailed
        );
        assert!(result.callable_fingerprints.callables.is_empty());
        assert_eq!(
            result.region_fingerprints.status,
            FingerprintExtractionStatus::ParserFailed
        );
        assert!(result.region_fingerprints.anchors.is_empty());
    }

    #[test]
    fn elif_chain_is_flat_for_metrics_and_bounded_for_parser_safety() {
        let source = concat!(
            "def choose(value):\n",
            "    if value == 0: return 0\n",
            "    elif value == 1: return 1\n",
            "    elif value == 2: return 2\n",
            "    elif value == 3: return 3\n",
            "    elif value == 4: return 4\n",
            "    else: return 5\n",
        );
        let result = facts(
            source,
            &RuleLimits {
                max_nesting: 1,
                ..RuleLimits::default()
            },
        );
        assert!(
            result
                .diagnostics
                .iter()
                .all(|diagnostic| { diagnostic.rule_id != "complexity.max-nesting" })
        );

        let mut excessive = String::from("def choose(value):\n    if value == 0: return 0\n");
        for value in 1..300 {
            std::fmt::Write::write_fmt(
                &mut excessive,
                format_args!("    elif value == {value}: return {value}\n"),
            )
            .unwrap();
        }
        assert!(matches!(
            analyze(&file(excessive.into_bytes()), &RuleLimits::default(), &CancelToken::new()),
            Err(AnalysisError::Unsupported(message)) if message.contains("structural depth")
        ));
    }

    #[test]
    fn rejects_recursive_expression_shapes_before_parser_or_ast_walk() {
        for source in [
            format!("value = {}1{}\n", "[".repeat(300), "]".repeat(300)),
            format!("value = {}True\n", "not ".repeat(300)),
            format!("value = {}1\n", "1 + ".repeat(300)),
            format!("value = root{}\n", ".field".repeat(300)),
            format!("value = f\"{{{}1}}\"\n", "1 + ".repeat(300)),
        ] {
            assert!(matches!(
                analyze(&file(source.into_bytes()), &RuleLimits::default(), &CancelToken::new()),
                Err(AnalysisError::Unsupported(message)) if message.contains("structural depth")
            ));
        }
    }

    #[test]
    fn decorators_count_toward_size_but_defaults_do_not_count_toward_body_complexity() {
        let mut decorated = "@deco\n".repeat(101);
        decorated.push_str("def decorated():\n    return 1\n");
        let decorated = facts(&decorated, &RuleLimits::default());
        assert!(
            decorated
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.rule_id == "complexity.max-function-lines" })
        );

        let defaults_source = concat!(
            "def simple(value=(1 if a else 2 if b else 3 if c else 4 if d else 5 ",
            "if e else 6 if f else 7 if g else 8 if h else 9 if i else 10 if j else 11)):\n",
            "    return value\n",
        );
        let defaults = facts(defaults_source, &RuleLimits::default());
        assert!(
            defaults
                .diagnostics
                .iter()
                .all(|diagnostic| { diagnostic.rule_id != "complexity.max-cyclomatic-complexity" })
        );
    }

    #[test]
    fn syntax_and_lambda_entities_use_local_source_context() {
        let first = facts("first = (\n", &RuleLimits::default());
        let second = facts("second = [\n", &RuleLimits::default());
        assert_ne!(
            first.diagnostics[0].entity_key,
            second.diagnostics[0].entity_key
        );

        let limits = RuleLimits {
            max_parameters: 5,
            ..RuleLimits::default()
        };
        let baseline = facts("bad = lambda a,b,c,d,e,f: a\n", &limits);
        let shifted = facts(
            "small = lambda value: value\nbad = lambda a,b,c,d,e,f: a\n",
            &limits,
        );
        let baseline_entity = baseline
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.rule_id == "complexity.max-parameters")
            .unwrap()
            .entity_key
            .clone();
        let shifted_entity = shifted
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.rule_id == "complexity.max-parameters")
            .unwrap()
            .entity_key
            .clone();
        assert_eq!(baseline_entity, shifted_entity);
    }

    #[test]
    fn parses_stub_syntax() {
        let source = concat!(
            "from typing import Protocol\n",
            "class Service(Protocol):\n",
            "    def call(self, value: str) -> bytes: ...\n",
        );
        let result = facts(source, &RuleLimits::default());
        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn disambiguates_repeated_callable_entities() {
        let source = "def same(a, b):\n    return a\ndef same(a, b):\n    return b\n";
        let limits = RuleLimits {
            max_parameters: 1,
            ..RuleLimits::default()
        };
        let result = facts(source, &limits);
        let entities = result
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.rule_id == "complexity.max-parameters")
            .map(|diagnostic| diagnostic.entity_key.as_str())
            .collect::<Vec<_>>();
        assert_eq!(entities, ["callable:same:0", "callable:same:1"]);
    }

    #[test]
    fn honours_pre_cancelled_request() {
        let cancel = CancelToken::new();
        cancel.cancel();
        assert!(matches!(
            analyze(
                &file(b"value = 1\n".to_vec()),
                &RuleLimits::default(),
                &cancel
            ),
            Err(AnalysisError::Cancelled)
        ));
    }
}

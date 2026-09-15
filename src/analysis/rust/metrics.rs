use super::{
    AnalysisError, AstNode, BTreeMap, CANCELLATION_POLL_INTERVAL, CallableFingerprintFacts,
    CallableKind, CancelToken, Edition, FingerprintCollector, FingerprintToken, HasName, LineIndex,
    METRIC_SEMANTICS, RawDiagnostic, RuleLimits, RustFingerprintToken, Severity, SourceRange,
    SyntaxKind, SyntaxNode, TextRange, TextSize, WalkEvent, ast, check_cancel, fingerprint,
    hash_domain, parser_evidence,
};
use crate::analysis::metric_evidence;

pub(super) fn metric_diagnostics(
    root: &SyntaxNode,
    context: RustMetricContext<'_>,
    fingerprint_tokens: &[RustFingerprintToken],
) -> Result<(Vec<RawDiagnostic>, CallableFingerprintFacts), AnalysisError> {
    let mut diagnostics = Vec::new();
    let mut entity_occurrences = BTreeMap::<String, usize>::new();
    let mut fingerprints = FingerprintCollector::default();
    let mut enclosing_callable_end = None;

    for (index, node) in root.descendants().enumerate() {
        if index.is_multiple_of(CANCELLATION_POLL_INTERVAL) {
            check_cancel(context.cancel)?;
        }
        let Some(callable) = callable_from_node(node) else {
            continue;
        };

        collect_callable_fingerprint(
            &callable,
            &context,
            fingerprint_tokens,
            &mut fingerprints,
            &mut enclosing_callable_end,
        );

        let base_entity = callable.base_entity(context.text);
        let occurrence = entity_occurrences.entry(base_entity.clone()).or_default();
        let entity_key = format!("{base_entity}:{}", *occurrence);
        *occurrence = occurrence.saturating_add(1);
        let metrics = measure_callable(callable.syntax(), context.cancel)?;
        let callable_range = source_range(context.lines, callable.syntax().text_range());
        let function_lines = context.lines.line_span(
            usize::from(callable.syntax().text_range().start()),
            usize::from(callable.syntax().text_range().end()),
        );
        let common = CommonMetricEvidence {
            entity_key: &entity_key,
            entity_kind: callable.kind(),
            edition: context.edition,
            metrics: &metrics,
        };

        push_metric(
            &mut diagnostics,
            MetricDiagnostic {
                rule_id: "complexity.max-function-lines",
                metric_name: "lines",
                actual: function_lines,
                limit: context.limits.max_function_lines,
                range: callable_range,
                common,
                extra_evidence: None,
            },
        );
        push_metric(
            &mut diagnostics,
            MetricDiagnostic {
                rule_id: "complexity.max-parameters",
                metric_name: "parameters",
                actual: callable.parameters(),
                limit: context.limits.max_parameters,
                range: callable
                    .parameter_range()
                    .map_or(callable_range, |range| source_range(context.lines, range)),
                common,
                extra_evidence: callable
                    .receiver_excluded()
                    .then_some(("receiverExcluded", serde_json::json!(true))),
            },
        );
        push_metric(
            &mut diagnostics,
            MetricDiagnostic {
                rule_id: "complexity.max-nesting",
                metric_name: "nesting depth",
                actual: metrics.max_nesting,
                limit: context.limits.max_nesting,
                range: callable_range,
                common,
                extra_evidence: None,
            },
        );
        push_metric(
            &mut diagnostics,
            MetricDiagnostic {
                rule_id: "complexity.max-cyclomatic-complexity",
                metric_name: "cyclomatic complexity",
                actual: metrics.complexity,
                limit: context.limits.max_cyclomatic_complexity,
                range: callable_range,
                common,
                extra_evidence: None,
            },
        );
    }
    check_cancel(context.cancel)?;
    Ok((diagnostics, fingerprints.finish()))
}

fn collect_callable_fingerprint(
    callable: &Callable,
    context: &RustMetricContext<'_>,
    fingerprint_tokens: &[RustFingerprintToken],
    fingerprints: &mut FingerprintCollector,
    enclosing_callable_end: &mut Option<TextSize>,
) {
    let callable_range = callable.syntax().text_range();
    if !enclosing_callable_end.is_none_or(|end| callable_range.start() >= end) {
        return;
    }
    *enclosing_callable_end = Some(callable_range.end());
    let Some(body_range) = callable.body_range() else {
        return;
    };
    let start = usize::from(body_range.start());
    let end = usize::from(body_range.end());
    fingerprints.push(fingerprint(
        "rust",
        callable.fingerprint_kind(),
        source_range(context.lines, body_range),
        fingerprint_tokens
            .iter()
            .filter(|token| token.start >= start && token.end <= end)
            .map(|token| FingerprintToken {
                tag: 0,
                text: context
                    .text
                    .as_bytes()
                    .get(token.start..token.end)
                    .unwrap_or_default(),
                line: context.lines.position(token.start).line,
                counted: true,
                start_byte: context.lines.position(token.start).byte,
                end_byte: context.lines.position(token.end).byte,
            }),
    ));
}

fn source_range(lines: &LineIndex, range: TextRange) -> SourceRange {
    lines.byte_range(usize::from(range.start()), usize::from(range.end()))
}

#[derive(Clone, Copy)]
struct CommonMetricEvidence<'a> {
    entity_key: &'a str,
    entity_kind: &'a str,
    edition: Edition,
    metrics: &'a CallableMetrics,
}

struct MetricDiagnostic<'a> {
    rule_id: &'a str,
    metric_name: &'a str,
    actual: u32,
    limit: u32,
    range: SourceRange,
    common: CommonMetricEvidence<'a>,
    extra_evidence: Option<(&'a str, serde_json::Value)>,
}

#[derive(Clone, Copy)]
pub(super) struct RustMetricContext<'a> {
    pub(super) text: &'a str,
    pub(super) lines: &'a LineIndex,
    pub(super) edition: Edition,
    pub(super) limits: &'a RuleLimits,
    pub(super) cancel: &'a CancelToken,
}

fn callable_from_node(node: SyntaxNode) -> Option<Callable> {
    if let Some(function) = ast::Fn::cast(node.clone()) {
        Some(Callable::function(function))
    } else {
        ast::ClosureExpr::cast(node).map(Callable::closure)
    }
}

fn push_metric(diagnostics: &mut Vec<RawDiagnostic>, diagnostic: MetricDiagnostic<'_>) {
    if diagnostic.actual <= diagnostic.limit {
        return;
    }
    let mut evidence = metric_evidence(
        parser_evidence(diagnostic.common.edition),
        diagnostic.actual,
        diagnostic.limit,
    );
    evidence.insert(
        "entityKind".into(),
        serde_json::json!(diagnostic.common.entity_kind),
    );
    evidence.insert(
        "metricSemantics".into(),
        serde_json::json!(METRIC_SEMANTICS),
    );
    if diagnostic.common.metrics.opaque_macro_count > 0 {
        evidence.insert("macroBodiesOpaque".into(), serde_json::json!(true));
        evidence.insert(
            "opaqueMacroCount".into(),
            serde_json::json!(diagnostic.common.metrics.opaque_macro_count),
        );
    }
    if let Some((key, value)) = diagnostic.extra_evidence {
        evidence.insert(key.into(), value);
    }
    diagnostics.push(RawDiagnostic {
        rule_id: diagnostic.rule_id.into(),
        severity: Severity::Warning,
        message: format!(
            "Rust callable has {} {}; configured maximum is {}",
            diagnostic.actual, diagnostic.metric_name, diagnostic.limit
        ),
        range: Some(diagnostic.range),
        entity_key: diagnostic.common.entity_key.into(),
        cause_key: format!("limit:{}", diagnostic.limit),
        evidence,
    });
}

#[derive(Clone)]
enum Callable {
    Function(ast::Fn),
    Closure(ast::ClosureExpr),
}

impl Callable {
    fn function(function: ast::Fn) -> Self {
        Self::Function(function)
    }

    fn closure(closure: ast::ClosureExpr) -> Self {
        Self::Closure(closure)
    }

    fn syntax(&self) -> &SyntaxNode {
        match self {
            Self::Function(function) => function.syntax(),
            Self::Closure(closure) => closure.syntax(),
        }
    }

    const fn kind(&self) -> &'static str {
        match self {
            Self::Function(_) => "function",
            Self::Closure(_) => "closure",
        }
    }

    const fn fingerprint_kind(&self) -> CallableKind {
        match self {
            Self::Function(_) => CallableKind::Function,
            Self::Closure(_) => CallableKind::Closure,
        }
    }

    fn body_range(&self) -> Option<TextRange> {
        match self {
            Self::Function(function) => block_content_range(&function.body()?),
            Self::Closure(closure) => expression_content_range(&closure.body()?),
        }
    }

    fn parameters(&self) -> u32 {
        let count = match self {
            Self::Function(function) => function
                .param_list()
                .map_or(0, |list| list.params().count()),
            Self::Closure(closure) => closure.param_list().map_or(0, |list| list.params().count()),
        };
        u32::try_from(count).unwrap_or(u32::MAX)
    }

    fn parameter_range(&self) -> Option<TextRange> {
        match self {
            Self::Function(function) => {
                function.param_list().map(|list| list.syntax().text_range())
            }
            Self::Closure(closure) => closure.param_list().map(|list| list.syntax().text_range()),
        }
    }

    const fn receiver_excluded(&self) -> bool {
        matches!(self, Self::Function(_))
    }

    fn base_entity(&self, _text: &str) -> String {
        let name = match self {
            Self::Function(function) => function.name().map_or_else(
                || "<anonymous>".into(),
                |name| name.syntax().text().to_string(),
            ),
            Self::Closure(_) => "<closure>".into(),
        };
        let owner = callable_owner(self.syntax());
        let digest = hash_domain(
            "rust-callable-entity/v2",
            &[self.kind().as_bytes(), owner.as_bytes(), name.as_bytes()],
        );
        format!("rust:{}:{}", self.kind(), hex::encode(&digest[..12]))
    }
}

fn expression_content_range(expression: &ast::Expr) -> Option<TextRange> {
    ast::BlockExpr::cast(expression.syntax().clone()).map_or_else(
        || Some(expression.syntax().text_range()),
        |block| block_content_range(&block),
    )
}

fn block_content_range(block: &ast::BlockExpr) -> Option<TextRange> {
    let statements = block.stmt_list()?;
    Some(TextRange::new(
        statements.l_curly_token()?.text_range().end(),
        statements.r_curly_token()?.text_range().start(),
    ))
}

fn callable_owner(syntax: &SyntaxNode) -> String {
    let mut components = syntax
        .ancestors()
        .filter_map(|node| {
            if let Some(module) = ast::Module::cast(node.clone()) {
                return module
                    .name()
                    .map(|name| format!("module:{}", name.syntax().text()));
            }
            if let Some(trait_) = ast::Trait::cast(node.clone()) {
                return trait_
                    .name()
                    .map(|name| format!("trait:{}", name.syntax().text()));
            }
            ast::Impl::cast(node).map(|impl_| {
                let trait_name = impl_
                    .trait_()
                    .map(|ty| ty.syntax().text().to_string())
                    .unwrap_or_default();
                let self_type = impl_
                    .self_ty()
                    .map(|ty| ty.syntax().text().to_string())
                    .unwrap_or_default();
                format!("impl:{trait_name}:{self_type}")
            })
        })
        .collect::<Vec<_>>();
    components.reverse();
    components.join("/")
}

#[derive(Clone, Copy, Debug)]
struct CallableMetrics {
    complexity: u32,
    max_nesting: u32,
    opaque_macro_count: u32,
}

fn measure_callable(
    root: &SyntaxNode,
    cancel: &CancelToken,
) -> Result<CallableMetrics, AnalysisError> {
    let mut metrics = MetricTracker::default();
    let mut walker = root.preorder();
    let mut visited = 0usize;
    while let Some(event) = walker.next() {
        visited = visited.saturating_add(1);
        if visited.is_multiple_of(CANCELLATION_POLL_INTERVAL) {
            check_cancel(cancel)?;
        }
        match event {
            WalkEvent::Enter(node) => {
                if metrics.enter(root, &node) {
                    walker.skip_subtree();
                }
            }
            WalkEvent::Leave(node) => metrics.leave(&node),
        }
    }
    check_cancel(cancel)?;
    Ok(metrics.finish())
}

struct MetricTracker {
    complexity: u32,
    current_nesting: u32,
    max_nesting: u32,
    opaque_macro_count: u32,
}

impl Default for MetricTracker {
    fn default() -> Self {
        Self {
            complexity: 1,
            current_nesting: 0,
            max_nesting: 0,
            opaque_macro_count: 0,
        }
    }
}

impl MetricTracker {
    fn enter(&mut self, root: &SyntaxNode, node: &SyntaxNode) -> bool {
        if node != root && matches!(node.kind(), SyntaxKind::FN | SyntaxKind::CLOSURE_EXPR) {
            return true;
        }
        if is_opaque_macro(node.kind()) {
            self.opaque_macro_count = self.opaque_macro_count.saturating_add(1);
            return true;
        }
        if is_nesting_node(node) {
            self.current_nesting = self.current_nesting.saturating_add(1);
            self.max_nesting = self.max_nesting.max(self.current_nesting);
        }
        self.complexity = self.complexity.saturating_add(complexity_increment(node));
        false
    }

    fn leave(&mut self, node: &SyntaxNode) {
        if is_nesting_node(node) {
            self.current_nesting = self.current_nesting.saturating_sub(1);
        }
    }

    const fn finish(self) -> CallableMetrics {
        CallableMetrics {
            complexity: self.complexity,
            max_nesting: self.max_nesting,
            opaque_macro_count: self.opaque_macro_count,
        }
    }
}

fn is_nesting_node(node: &SyntaxNode) -> bool {
    matches!(
        node.kind(),
        SyntaxKind::IF_EXPR
            | SyntaxKind::FOR_EXPR
            | SyntaxKind::WHILE_EXPR
            | SyntaxKind::LOOP_EXPR
            | SyntaxKind::MATCH_EXPR
    ) && !(node.kind() == SyntaxKind::IF_EXPR && is_else_if(node))
}

fn is_else_if(node: &SyntaxNode) -> bool {
    let mut previous = node.first_token().and_then(|token| token.prev_token());
    while previous.as_ref().is_some_and(|token| {
        matches!(
            token.kind(),
            SyntaxKind::WHITESPACE | SyntaxKind::NEWLINE | SyntaxKind::COMMENT
        )
    }) {
        previous = previous.and_then(|token| token.prev_token());
    }
    previous.is_some_and(|token| token.kind() == SyntaxKind::ELSE_KW)
}

const fn is_opaque_macro(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::MACRO_EXPR
            | SyntaxKind::MACRO_STMTS
            | SyntaxKind::MACRO_ITEMS
            | SyntaxKind::MACRO_PAT
            | SyntaxKind::MACRO_TYPE
            | SyntaxKind::MACRO_CALL
            | SyntaxKind::MACRO_RULES
            | SyntaxKind::MACRO_DEF
            | SyntaxKind::FORMAT_ARGS_EXPR
            | SyntaxKind::ASM_EXPR
            | SyntaxKind::INCLUDE_BYTES_EXPR
    )
}

fn complexity_increment(node: &SyntaxNode) -> u32 {
    match node.kind() {
        SyntaxKind::IF_EXPR
        | SyntaxKind::FOR_EXPR
        | SyntaxKind::WHILE_EXPR
        | SyntaxKind::LOOP_EXPR
        | SyntaxKind::MATCH_ARM
        | SyntaxKind::MATCH_GUARD
        | SyntaxKind::LET_ELSE
        | SyntaxKind::TRY_EXPR => 1,
        SyntaxKind::BIN_EXPR
            if node.children_with_tokens().any(|element| {
                element.into_token().is_some_and(|token| {
                    matches!(token.kind(), SyntaxKind::AMP2 | SyntaxKind::PIPE2)
                })
            }) =>
        {
            1
        }
        _ => 0,
    }
}

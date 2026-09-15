use std::collections::BTreeMap;

use tree_sitter::Node;

use crate::{
    analysis::{
        AnalysisError,
        dedup::{FingerprintCollector, FingerprintToken, fingerprint, region_fingerprints},
        metric_evidence,
    },
    cancel::CancelToken,
    identity::hash_domain,
    limits::{MAX_DIAGNOSTICS, RuleLimits},
    model::{
        CallableFingerprintFacts, CallableKind, RawDiagnostic, RegionFingerprintFacts, Severity,
        SourceRange,
    },
};

use super::{
    METRIC_SEMANTICS,
    input::{GoToken, LineIndex, parser_evidence},
    node_text,
    walk::{self, WalkEvent},
};

pub(super) struct MetricFacts {
    pub(super) diagnostics: Vec<RawDiagnostic>,
    pub(super) callables: CallableFingerprintFacts,
    pub(super) regions: RegionFingerprintFacts,
}

#[derive(Clone, Copy)]
pub(super) struct MetricInput<'a> {
    pub(super) source: &'a [u8],
    pub(super) tokens: &'a [GoToken],
    pub(super) lines: &'a LineIndex,
    pub(super) limits: &'a RuleLimits,
    pub(super) cancel: &'a CancelToken,
}

pub(super) fn extract(
    root: Node<'_>,
    input: MetricInput<'_>,
) -> Result<MetricFacts, AnalysisError> {
    let mut collector = Collector {
        source: input.source,
        tokens: input.tokens,
        lines: input.lines,
        limits: input.limits,
        cancel: input.cancel,
        diagnostics: Vec::new(),
        fingerprints: FingerprintCollector::default(),
        entities: BTreeMap::new(),
    };
    walk::walk(root, input.cancel, |event| collector.observe(event))?;
    Ok(collector.finish())
}

struct Collector<'a> {
    source: &'a [u8],
    tokens: &'a [GoToken],
    lines: &'a LineIndex,
    limits: &'a RuleLimits,
    cancel: &'a CancelToken,
    diagnostics: Vec<RawDiagnostic>,
    fingerprints: FingerprintCollector,
    entities: BTreeMap<String, usize>,
}

impl Collector<'_> {
    fn observe(&mut self, event: WalkEvent<'_>) -> Result<bool, AnalysisError> {
        let WalkEvent::Enter(node) = event else {
            return Ok(true);
        };
        if callable_kind(node.kind()).is_some() {
            self.analyze_callable(node)?;
        }
        Ok(true)
    }

    fn analyze_callable(&mut self, node: Node<'_>) -> Result<(), AnalysisError> {
        let Some(kind) = callable_kind(node.kind()) else {
            return Ok(());
        };
        let Some(body) = node.child_by_field_name("body") else {
            return Ok(());
        };
        let metrics = measure_callable(body, self.cancel)?;
        let range = self.lines.byte_range(node.start_byte(), node.end_byte());
        let entity = self.next_entity(node, kind);
        let values = metric_values(node, range, metrics, self.limits);
        for value in values {
            push_metric(&mut self.diagnostics, value, range, &entity, node.kind());
        }
        self.push_fingerprint(body, kind)?;
        Ok(())
    }

    fn next_entity(&mut self, node: Node<'_>, kind: CallableKind) -> String {
        let base = callable_entity(node, self.source, kind);
        let occurrence = self.entities.entry(base.clone()).or_default();
        let entity = format!("{base}:{}", *occurrence);
        *occurrence = occurrence.saturating_add(1);
        entity
    }

    fn push_fingerprint(
        &mut self,
        body: Node<'_>,
        kind: CallableKind,
    ) -> Result<(), AnalysisError> {
        let body_start = body.start_byte().saturating_add(1).min(body.end_byte());
        let body_end = body.end_byte().saturating_sub(1).max(body_start);
        let nested = nested_callable_ranges(body, self.cancel)?;
        self.fingerprints.push(fingerprint(
            "go",
            kind,
            self.lines.byte_range(body_start, body_end),
            self.tokens
                .iter()
                .filter(|token| token.start >= body_start && token.end <= body_end)
                .filter(|token| outside_ranges(token, &nested))
                .map(|token| fingerprint_token(token, self.source, self.lines)),
        ));
        Ok(())
    }

    fn finish(self) -> MetricFacts {
        MetricFacts {
            diagnostics: self.diagnostics,
            callables: self.fingerprints.finish(),
            regions: region_fingerprints(
                "go",
                self.tokens
                    .iter()
                    .map(|token| fingerprint_token(token, self.source, self.lines)),
            ),
        }
    }
}

fn outside_ranges(token: &GoToken, ranges: &[(usize, usize)]) -> bool {
    !ranges
        .iter()
        .any(|(start, end)| token.start >= *start && token.end <= *end)
}

fn fingerprint_token<'a>(
    token: &GoToken,
    source: &'a [u8],
    lines: &LineIndex,
) -> FingerprintToken<'a> {
    FingerprintToken {
        tag: token.tag,
        text: token_text(token, source),
        line: lines.position(token.start).line,
        counted: token.counted,
        start_byte: lines.position(token.start).byte,
        end_byte: lines.position(token.end).byte,
    }
}

fn token_text<'a>(token: &GoToken, source: &'a [u8]) -> &'a [u8] {
    if token.synthetic_newline {
        b"\n"
    } else {
        source.get(token.start..token.end).unwrap_or_default()
    }
}

#[derive(Clone, Copy)]
struct CallableMetrics {
    complexity: u32,
    max_nesting: u32,
}

fn measure_callable(
    body: Node<'_>,
    cancel: &CancelToken,
) -> Result<CallableMetrics, AnalysisError> {
    let mut tracker = MetricTracker {
        complexity: 1,
        nesting: 0,
        max_nesting: 0,
    };
    walk::walk(body, cancel, |event| Ok(tracker.observe(event, body)))?;
    Ok(CallableMetrics {
        complexity: tracker.complexity,
        max_nesting: tracker.max_nesting,
    })
}

struct MetricTracker {
    complexity: u32,
    nesting: u32,
    max_nesting: u32,
}

impl MetricTracker {
    fn observe(&mut self, event: WalkEvent<'_>, body: Node<'_>) -> bool {
        match event {
            WalkEvent::Enter(node) => self.enter(node, body),
            WalkEvent::Leave(node) => {
                self.leave(node);
                true
            }
        }
    }

    fn enter(&mut self, node: Node<'_>, body: Node<'_>) -> bool {
        if node != body && callable_kind(node.kind()).is_some() {
            return false;
        }
        self.complexity = self.complexity.saturating_add(complexity_increment(node));
        if is_nesting_node(node) {
            self.nesting = self.nesting.saturating_add(1);
            self.max_nesting = self.max_nesting.max(self.nesting);
        }
        true
    }

    fn leave(&mut self, node: Node<'_>) {
        if is_nesting_node(node) {
            self.nesting = self.nesting.saturating_sub(1);
        }
    }
}

fn complexity_increment(node: Node<'_>) -> u32 {
    u32::from(
        matches!(
            node.kind(),
            "if_statement"
                | "for_statement"
                | "expression_case"
                | "type_case"
                | "communication_case"
        ) || logical_binary(node),
    )
}

fn logical_binary(node: Node<'_>) -> bool {
    node.kind() == "binary_expression"
        && node
            .child_by_field_name("operator")
            .is_some_and(|operator| matches!(operator.kind(), "&&" | "||"))
}

fn is_nesting_node(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "if_statement"
            | "for_statement"
            | "expression_switch_statement"
            | "type_switch_statement"
            | "select_statement"
    ) && !is_else_if(node)
}

fn is_else_if(node: Node<'_>) -> bool {
    if node.kind() != "if_statement" {
        return false;
    }
    node.parent().is_some_and(|parent| {
        parent.kind() == "if_statement"
            && parent
                .child_by_field_name("alternative")
                .is_some_and(|alternative| alternative.id() == node.id())
    })
}

fn nested_callable_ranges(
    body: Node<'_>,
    cancel: &CancelToken,
) -> Result<Vec<(usize, usize)>, AnalysisError> {
    let mut ranges = Vec::new();
    walk::walk(body, cancel, |event| {
        let WalkEvent::Enter(node) = event else {
            return Ok(true);
        };
        if node != body && callable_kind(node.kind()).is_some() {
            ranges.push((node.start_byte(), node.end_byte()));
            Ok(false)
        } else {
            Ok(true)
        }
    })?;
    Ok(ranges)
}

fn callable_kind(kind: &str) -> Option<CallableKind> {
    match kind {
        "function_declaration" => Some(CallableKind::Function),
        "method_declaration" => Some(CallableKind::Method),
        "func_literal" => Some(CallableKind::Closure),
        _ => None,
    }
}

fn callable_entity(node: Node<'_>, source: &[u8], kind: CallableKind) -> String {
    let name = node
        .child_by_field_name("name")
        .and_then(|item| node_text(item, source))
        .unwrap_or("<literal>");
    let owner = method_owner(node, source);
    let digest = hash_domain(
        "go-callable-entity/v1",
        &[
            format!("{kind:?}").as_bytes(),
            owner.as_bytes(),
            name.as_bytes(),
        ],
    );
    format!("go:{}", hex::encode(&digest[..12]))
}

fn method_owner(node: Node<'_>, source: &[u8]) -> String {
    if node.kind() != "method_declaration" {
        return String::new();
    }
    node.child_by_field_name("receiver")
        .and_then(|item| super::interfaces::receiver_type_name(item, source))
        .unwrap_or_default()
}

fn parameter_count(node: Node<'_>) -> u32 {
    let Some(parameters) = node.child_by_field_name("parameters") else {
        return 0;
    };
    let mut count = 0u32;
    let mut cursor = parameters.walk();
    for parameter in parameters.named_children(&mut cursor) {
        count = count.saturating_add(parameter_width(parameter));
    }
    count
}

fn parameter_width(parameter: Node<'_>) -> u32 {
    if !matches!(
        parameter.kind(),
        "parameter_declaration" | "variadic_parameter_declaration"
    ) {
        return 0;
    }
    let mut cursor = parameter.walk();
    let names = parameter
        .children_by_field_name("name", &mut cursor)
        .count();
    u32::try_from(names.max(1)).unwrap_or(u32::MAX)
}

#[derive(Clone, Copy)]
struct Metric<'a> {
    rule_id: &'a str,
    label: &'a str,
    actual: u32,
    limit: u32,
}

fn metric_values(
    node: Node<'_>,
    range: SourceRange,
    measured: CallableMetrics,
    limits: &RuleLimits,
) -> [Metric<'static>; 4] {
    let lines = range
        .end
        .line
        .saturating_sub(range.start.line)
        .saturating_add(1);
    [
        Metric {
            rule_id: "complexity.max-function-lines",
            label: "function lines",
            actual: lines,
            limit: limits.max_function_lines,
        },
        Metric {
            rule_id: "complexity.max-parameters",
            label: "function parameters",
            actual: parameter_count(node),
            limit: limits.max_parameters,
        },
        Metric {
            rule_id: "complexity.max-nesting",
            label: "function nesting",
            actual: measured.max_nesting,
            limit: limits.max_nesting,
        },
        Metric {
            rule_id: "complexity.max-cyclomatic-complexity",
            label: "cyclomatic complexity",
            actual: measured.complexity,
            limit: limits.max_cyclomatic_complexity,
        },
    ]
}

fn push_metric(
    diagnostics: &mut Vec<RawDiagnostic>,
    metric: Metric<'_>,
    range: SourceRange,
    entity: &str,
    entity_kind: &str,
) {
    if metric.actual <= metric.limit || diagnostics.len() >= MAX_DIAGNOSTICS {
        return;
    }
    let mut evidence = metric_evidence(parser_evidence(), metric.actual, metric.limit);
    evidence.insert("entityKind".into(), serde_json::json!(entity_kind));
    evidence.insert(
        "metricSemantics".into(),
        serde_json::json!(METRIC_SEMANTICS),
    );
    if entity_kind == "method_declaration" {
        evidence.insert("receiverExcluded".into(), serde_json::json!(true));
    }
    diagnostics.push(RawDiagnostic {
        rule_id: metric.rule_id.into(),
        severity: Severity::Warning,
        message: format!(
            "Go callable has {} {}; configured maximum is {}",
            metric.actual, metric.label, metric.limit
        ),
        range: Some(range),
        entity_key: entity.into(),
        cause_key: format!("limit:{}", metric.limit),
        evidence,
    });
}

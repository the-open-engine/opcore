use super::{
    AnalysisError, BTreeMap, CANCELLATION_POLL_INTERVAL, CancelToken, Delimiters, FunctionFact,
    Kind, LexToken, RawDiagnostic, RuleLimits, Severity, SourceRange, check_cancel,
    parser_evidence,
};
use crate::analysis::metric_evidence;

pub(super) fn metric_diagnostics(
    tokens: &[LexToken],
    delimiters: &Delimiters,
    functions: &[FunctionFact],
    limits: &RuleLimits,
    cancel: &CancelToken,
) -> Result<Vec<RawDiagnostic>, AnalysisError> {
    let owners = function_owners(tokens.len(), functions);
    let complexities = function_complexities(tokens, functions, &owners);
    let nestings = function_nestings(tokens, delimiters, functions, &owners);
    let mut diagnostics = Vec::new();
    let mut entity_occurrences = BTreeMap::<String, usize>::new();
    for (function_index, function) in functions.iter().enumerate() {
        if function_index.is_multiple_of(CANCELLATION_POLL_INTERVAL) {
            check_cancel(cancel)?;
        }
        let range = byte_range_for_tokens(tokens, function.start, function.end);
        let lines = range
            .end
            .line
            .saturating_sub(range.start.line)
            .saturating_add(1);
        let params = function.parameter_count;
        let complexity = complexities[function_index];
        let nesting = nestings[function_index];
        let base_entity = format!("function:{}", function.name);
        let occurrence = entity_occurrences.entry(base_entity.clone()).or_default();
        let entity = format!("{base_entity}:{}", *occurrence);
        *occurrence = occurrence.saturating_add(1);

        maybe_metric(
            &mut diagnostics,
            MetricDiagnostic {
                rule_id: "complexity.max-function-lines",
                label: "function lines",
                actual: lines,
                limit: limits.max_function_lines,
                range,
                entity: &entity,
            },
        );
        maybe_metric(
            &mut diagnostics,
            MetricDiagnostic {
                rule_id: "complexity.max-parameters",
                label: "function parameters",
                actual: params,
                limit: limits.max_parameters,
                range,
                entity: &entity,
            },
        );
        maybe_metric(
            &mut diagnostics,
            MetricDiagnostic {
                rule_id: "complexity.max-nesting",
                label: "function nesting",
                actual: nesting,
                limit: limits.max_nesting,
                range,
                entity: &entity,
            },
        );
        maybe_metric(
            &mut diagnostics,
            MetricDiagnostic {
                rule_id: "complexity.max-cyclomatic-complexity",
                label: "cyclomatic complexity",
                actual: complexity,
                limit: limits.max_cyclomatic_complexity,
                range,
                entity: &entity,
            },
        );
    }
    Ok(diagnostics)
}

fn function_owners(token_count: usize, functions: &[FunctionFact]) -> Vec<Option<usize>> {
    let mut starts = vec![Vec::new(); token_count];
    for (index, function) in functions.iter().enumerate() {
        if function.start < token_count {
            starts[function.start].push(index);
        }
    }
    for indexes in &mut starts {
        indexes.sort_by_key(|index| std::cmp::Reverse(functions[*index].end));
    }
    let mut owners = vec![None; token_count];
    let mut stack = Vec::<usize>::new();
    for token in 0..token_count {
        while stack
            .last()
            .is_some_and(|index| functions[*index].end < token)
        {
            let _ = stack.pop();
        }
        stack.extend(starts[token].iter().copied());
        owners[token] = stack.last().copied();
    }
    owners
}

fn function_complexities(
    tokens: &[LexToken],
    functions: &[FunctionFact],
    owners: &[Option<usize>],
) -> Vec<u32> {
    let mut complexities = vec![1u32; functions.len()];
    let type_only = type_only_token_mask(tokens, functions, owners);
    for (index, token) in tokens.iter().enumerate() {
        let Some(owner) = owners[index] else {
            continue;
        };
        if !type_only[index]
            && in_function_body(functions[owner].body, index)
            && matches!(
                token.kind,
                Kind::If
                    | Kind::For
                    | Kind::While
                    | Kind::Case
                    | Kind::Catch
                    | Kind::Question
                    | Kind::Amp2
                    | Kind::Pipe2
                    | Kind::Question2
            )
        {
            complexities[owner] = complexities[owner].saturating_add(1);
        }
    }
    complexities
}

fn type_only_token_mask(
    tokens: &[LexToken],
    functions: &[FunctionFact],
    owners: &[Option<usize>],
) -> Vec<bool> {
    let mut mask = vec![false; tokens.len()];
    for (start, token) in tokens.iter().enumerate() {
        let Some(owner) = owners[start] else {
            continue;
        };
        if token.kind != Kind::Type
            || !in_function_body(functions[owner].body, start)
            || !tokens
                .get(start + 1)
                .is_some_and(|next| next.kind == Kind::Ident)
        {
            continue;
        }
        for index in start..tokens.len() {
            if owners[index] != Some(owner) {
                break;
            }
            mask[index] = true;
            if tokens[index].kind == Kind::Semicolon {
                break;
            }
        }
    }
    mask
}

fn function_nestings(
    tokens: &[LexToken],
    delimiters: &Delimiters,
    functions: &[FunctionFact],
    owners: &[Option<usize>],
) -> Vec<u32> {
    let mut intervals = nesting_intervals(tokens, delimiters, functions, owners);
    intervals
        .iter_mut()
        .map(|function_intervals| maximum_nesting(function_intervals))
        .collect()
}

fn nesting_intervals(
    tokens: &[LexToken],
    delimiters: &Delimiters,
    functions: &[FunctionFact],
    owners: &[Option<usize>],
) -> Vec<Vec<(usize, usize)>> {
    let mut intervals = vec![Vec::new(); functions.len()];
    for (index, token) in tokens.iter().enumerate() {
        let Some(owner) = owners[index] else {
            continue;
        };
        if !in_function_body(functions[owner].body, index)
            || !is_nesting_keyword(token.kind)
            || (token.kind == Kind::Else
                && tokens
                    .get(index + 1)
                    .is_some_and(|next| next.kind == Kind::If))
        {
            continue;
        }
        let function_end = functions[owner].body.map_or(index, |(_, end)| end);
        if let Some(start) = control_statement_start(tokens, delimiters, index, function_end)
            && owners[start] == Some(owner)
            && let Some(interval) = nesting_interval(tokens, delimiters, index, start, function_end)
        {
            intervals[owner].push(interval);
        }
    }
    intervals
}

fn nesting_interval(
    tokens: &[LexToken],
    delimiters: &Delimiters,
    keyword: usize,
    start: usize,
    function_end: usize,
) -> Option<(usize, usize)> {
    if tokens[start].kind == Kind::LCurly {
        return delimiters.brace_open[start].map(|close| (start, close));
    }
    Some((
        keyword,
        unbraced_statement_end(tokens, delimiters, start, function_end),
    ))
}

fn maximum_nesting(intervals: &mut [(usize, usize)]) -> u32 {
    intervals.sort_unstable();
    let mut active = Vec::<usize>::new();
    let mut maximum = 0u32;
    for (open, close) in intervals {
        while active
            .last()
            .is_some_and(|active_close| *active_close <= *open)
        {
            let _ = active.pop();
        }
        active.push(*close);
        maximum = maximum.max(u32::try_from(active.len()).unwrap_or(u32::MAX));
    }
    maximum
}

fn in_function_body(body: Option<(usize, usize)>, token: usize) -> bool {
    body.is_some_and(|(open, close)| open < token && token < close)
}

const fn is_nesting_keyword(kind: Kind) -> bool {
    matches!(
        kind,
        Kind::If
            | Kind::Else
            | Kind::For
            | Kind::While
            | Kind::Switch
            | Kind::Catch
            | Kind::Try
            | Kind::Finally
            | Kind::Do
            | Kind::With
    )
}

fn control_statement_start(
    tokens: &[LexToken],
    delimiters: &Delimiters,
    keyword: usize,
    function_end: usize,
) -> Option<usize> {
    let mut index = keyword + 1;
    if matches!(
        tokens[keyword].kind,
        Kind::If | Kind::For | Kind::While | Kind::Switch | Kind::Catch | Kind::With
    ) && tokens
        .get(index)
        .is_some_and(|token| token.kind == Kind::LParen)
    {
        index = delimiters.paren_open[index]?.saturating_add(1);
    }
    (index < function_end).then_some(index)
}

fn unbraced_statement_end(
    tokens: &[LexToken],
    delimiters: &Delimiters,
    start: usize,
    function_end: usize,
) -> usize {
    let mut index = start;
    while index < function_end {
        match tokens[index].kind {
            Kind::LParen => index = delimiters.paren_open[index].unwrap_or(index),
            Kind::LBrack => index = delimiters.bracket_open[index].unwrap_or(index),
            Kind::LCurly => index = delimiters.brace_open[index].unwrap_or(index),
            Kind::Semicolon => return index,
            _ => {}
        }
        index = index.saturating_add(1);
    }
    function_end
}

#[derive(Clone, Copy)]
struct MetricDiagnostic<'a> {
    rule_id: &'a str,
    label: &'a str,
    actual: u32,
    limit: u32,
    range: SourceRange,
    entity: &'a str,
}

fn maybe_metric(diagnostics: &mut Vec<RawDiagnostic>, metric: MetricDiagnostic<'_>) {
    if metric.actual <= metric.limit {
        return;
    }
    let evidence = metric_evidence(parser_evidence(), metric.actual, metric.limit);
    diagnostics.push(RawDiagnostic {
        rule_id: metric.rule_id.into(),
        severity: Severity::Warning,
        message: format!(
            "{}: {}; configured maximum is {}",
            metric.label, metric.actual, metric.limit
        ),
        range: Some(metric.range),
        entity_key: metric.entity.into(),
        cause_key: format!("limit:{}", metric.limit),
        evidence,
    });
}

fn byte_range_for_tokens(tokens: &[LexToken], start: usize, end: usize) -> SourceRange {
    let start_token = &tokens[start];
    let end_token = &tokens[end];
    SourceRange {
        start: start_token.start_position,
        end: end_token.end_position,
    }
}

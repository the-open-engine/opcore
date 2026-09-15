use std::collections::BTreeMap;

use crate::{
    analysis::AnalysisError,
    limits::{MAX_LINE_BYTES, RuleLimits},
    model::{FileFacts, Position, RawDiagnostic, Severity, SourceFile, SourceRange},
};

pub fn analyze(file: &SourceFile, limits: &RuleLimits) -> Result<FileFacts, AnalysisError> {
    if file.bytes.len() > crate::limits::MAX_SOURCE_BYTES {
        return Err(AnalysisError::Unsupported(format!(
            "file is {} bytes; limit is {}",
            file.bytes.len(),
            crate::limits::MAX_SOURCE_BYTES
        )));
    }

    let mut diagnostics = Vec::new();
    let mut line_count = 0u32;
    let mut line_start = 0usize;
    let mut cursor = 0usize;
    while cursor < file.bytes.len() {
        if !matches!(file.bytes[cursor], b'\n' | b'\r') {
            cursor += 1;
            continue;
        }
        check_line(
            &mut diagnostics,
            LineInput {
                file,
                limits,
                number: line_count.saturating_add(1),
                start: line_start,
                end: cursor,
            },
        )?;
        line_count = line_count.saturating_add(1);
        if file.bytes[cursor] == b'\r' && file.bytes.get(cursor + 1) == Some(&b'\n') {
            cursor += 1;
        }
        cursor += 1;
        line_start = cursor;
    }
    if line_start < file.bytes.len() {
        check_line(
            &mut diagnostics,
            LineInput {
                file,
                limits,
                number: line_count.saturating_add(1),
                start: line_start,
                end: file.bytes.len(),
            },
        )?;
        line_count = line_count.saturating_add(1);
    }
    if line_count > limits.max_file_lines {
        diagnostics.push(metric(MetricInput {
            rule_id: "hygiene.max-file-lines",
            message: format!(
                "file has {line_count} lines; configured maximum is {}",
                limits.max_file_lines
            ),
            line: 1,
            start: 0,
            end: file.bytes.len(),
            entity: "file".into(),
            actual: line_count as usize,
            limit: limits.max_file_lines,
        }));
    }
    Ok(FileFacts {
        diagnostics,
        ..FileFacts::default()
    })
}

#[derive(Clone, Copy)]
struct LineInput<'a> {
    file: &'a SourceFile,
    limits: &'a RuleLimits,
    number: u32,
    start: usize,
    end: usize,
}

fn check_line(
    diagnostics: &mut Vec<RawDiagnostic>,
    input: LineInput<'_>,
) -> Result<(), AnalysisError> {
    let content_start = if input.number == 1
        && input.file.bytes[input.start..input.end].starts_with(b"\xef\xbb\xbf")
    {
        input.start.saturating_add(3)
    } else {
        input.start
    };
    let content_len = input.end.saturating_sub(content_start);
    if content_len > MAX_LINE_BYTES {
        return Err(AnalysisError::Unsupported(format!(
            "line {} is {content_len} bytes; hard limit is {MAX_LINE_BYTES}",
            input.number
        )));
    }
    if content_len > input.limits.max_line_bytes as usize {
        diagnostics.push(metric(MetricInput {
            rule_id: "hygiene.max-line-bytes",
            message: format!(
                "line has {content_len} bytes; configured maximum is {}",
                input.limits.max_line_bytes
            ),
            line: input.number,
            start: content_start,
            end: input.end,
            entity: format!(
                "line:{}",
                crate::analysis::line_anchor(&input.file.bytes, input.start)
            ),
            actual: content_len,
            limit: input.limits.max_line_bytes,
        }));
    }
    Ok(())
}

struct MetricInput<'a> {
    rule_id: &'a str,
    message: String,
    line: u32,
    start: usize,
    end: usize,
    entity: String,
    actual: usize,
    limit: u32,
}

fn metric(input: MetricInput<'_>) -> RawDiagnostic {
    let mut evidence = BTreeMap::new();
    evidence.insert("actual".into(), serde_json::json!(input.actual));
    evidence.insert("limit".into(), serde_json::json!(input.limit));
    RawDiagnostic {
        rule_id: input.rule_id.into(),
        severity: Severity::Warning,
        message: input.message,
        range: Some(SourceRange {
            start: Position {
                line: input.line,
                column: 1,
                byte: u32::try_from(input.start).unwrap_or(u32::MAX),
            },
            end: Position {
                line: input.line,
                column: u32::try_from(input.end.saturating_sub(input.start) + 1)
                    .unwrap_or(u32::MAX),
                byte: u32::try_from(input.end).unwrap_or(u32::MAX),
            },
        }),
        entity_key: input.entity,
        cause_key: format!("limit:{}", input.limit),
        evidence,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{model::Language, path::RepoPath};

    fn file(bytes: Vec<u8>) -> SourceFile {
        SourceFile::new(
            RepoPath::from_protocol("source.py").unwrap(),
            bytes,
            Language::Python,
            "python:bundled-grammar".into(),
        )
    }

    #[test]
    fn line_limits_exclude_terminators_and_accept_universal_newlines() {
        let exact = [vec![b'x'; 512], b"\n".to_vec()].concat();
        assert!(
            analyze(&file(exact), &RuleLimits::default())
                .unwrap()
                .diagnostics
                .is_empty()
        );

        let cr_lines = b"x\r".repeat(1_501);
        let facts = analyze(&file(cr_lines), &RuleLimits::default()).unwrap();
        assert!(
            facts
                .diagnostics
                .iter()
                .any(|item| item.rule_id == "hygiene.max-file-lines")
        );
    }

    #[test]
    fn accepted_utf8_bom_is_not_logical_first_line_content() {
        let bytes = [
            b"\xef\xbb\xbf".as_slice(),
            vec![b'x'; 512].as_slice(),
            b"\n",
        ]
        .concat();
        assert!(
            analyze(&file(bytes), &RuleLimits::default())
                .unwrap()
                .diagnostics
                .is_empty()
        );
    }
}

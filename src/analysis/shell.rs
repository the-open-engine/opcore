use std::collections::BTreeMap;

use shuck_parser::{
    Error as ShuckError, ShellDialect, ShellProfile,
    parser::{ParseStatus, Parser},
};

use crate::{
    analysis::{AnalysisError, SHELL_PARSER_VERSION, preflight::bounded_structure},
    cancel::CancelToken,
    limits::MAX_DIAGNOSTICS,
    model::{FileFacts, Language, Position, RawDiagnostic, Severity, SourceFile, SourceRange},
};

const PARSER_NAME: &str = "shuck-parser";
const MAX_SHELL_DEPTH: usize = 64;
const MIN_PARSER_OPERATIONS: usize = 100_000;
const MAX_PARSER_OPERATIONS: usize = 2_000_000;
const OPERATIONS_PER_BYTE: usize = 64;

/// Analyzes Bash or declared `sh`-family syntax for the current host OS.
///
/// # Errors
///
/// Returns an error when analysis is cancelled, the captured OS or dialect is invalid, or a
/// parser safety limit is exceeded.
pub fn analyze(file: &SourceFile, cancel: &CancelToken) -> Result<FileFacts, AnalysisError> {
    check_cancel(cancel)?;
    if file.language != Language::Shell {
        return Err(AnalysisError::Unsupported(format!(
            "{} is not Shell source",
            file.language.family()
        )));
    }
    let dialect = mode_dialect(&file.language_mode)?;
    let source = match std::str::from_utf8(&file.bytes) {
        Ok(source) => source,
        Err(error) => {
            return Ok(parser_facts(vec![invalid_utf8_diagnostic(
                &file.bytes,
                error,
                dialect,
            )]));
        }
    };
    analyze_source(source, file.bytes.as_ref(), dialect, cancel)
}

fn analyze_source(
    source: &str,
    source_bytes: &[u8],
    dialect: Dialect,
    cancel: &CancelToken,
) -> Result<FileFacts, AnalysisError> {
    bounded_structure(source_bytes, "Shell", MAX_SHELL_DEPTH, cancel)?;
    check_cancel(cancel)?;
    let operations = source
        .len()
        .saturating_mul(OPERATIONS_PER_BYTE)
        .clamp(MIN_PARSER_OPERATIONS, MAX_PARSER_OPERATIONS);
    let parsed = Parser::with_limits_and_profile(
        source,
        MAX_SHELL_DEPTH,
        operations,
        ShellProfile::native(dialect.parser_dialect()),
    )
    .parse();
    if let Some(error) = parsed.terminal_error.as_ref()
        && terminal_resource_limit(error)
    {
        return Err(AnalysisError::Unsupported(format!(
            "Shell parser resource limit reached: {}",
            stable_message(&error.to_string())
        )));
    }
    check_cancel(cancel)?;
    let diagnostics = if parsed.status == ParseStatus::Clean {
        Vec::new()
    } else {
        syntax_diagnostics(
            source,
            dialect,
            parsed.diagnostics,
            parsed.terminal_error.as_ref(),
        )
    };
    check_cancel(cancel)?;
    Ok(parser_facts(diagnostics))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Dialect {
    Bash,
    Sh,
}

impl Dialect {
    const fn name(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::Sh => "sh",
        }
    }

    const fn parser_name(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::Sh => "posix",
        }
    }

    const fn parser_dialect(self) -> ShellDialect {
        match self {
            Self::Bash => ShellDialect::Bash,
            Self::Sh => ShellDialect::Posix,
        }
    }
}

fn mode_dialect(mode: &str) -> Result<Dialect, AnalysisError> {
    let mut components = mode.split(':');
    let family = components.next();
    let dialect = components.next();
    let os = components.next();
    if family != Some("shell") || components.next().is_some() {
        return Err(AnalysisError::Unsupported(format!(
            "unsupported Shell language mode '{mode}'"
        )));
    }
    if os != Some(std::env::consts::OS) {
        return Err(AnalysisError::Unsupported(format!(
            "Shell mode '{mode}' does not match the current host OS '{}'",
            std::env::consts::OS
        )));
    }
    match dialect {
        Some("bash") => Ok(Dialect::Bash),
        Some("sh") => Ok(Dialect::Sh),
        _ => Err(AnalysisError::Unsupported(format!(
            "unsupported Shell language mode '{mode}'"
        ))),
    }
}

fn parser_facts(diagnostics: Vec<RawDiagnostic>) -> FileFacts {
    FileFacts {
        diagnostics,
        parser: PARSER_NAME.into(),
        parser_version: SHELL_PARSER_VERSION.into(),
        ..FileFacts::default()
    }
}

#[derive(Debug)]
struct SyntaxIssue {
    message: String,
    start: usize,
    end: usize,
    kind: &'static str,
}

fn syntax_diagnostics(
    source: &str,
    dialect: Dialect,
    parser_diagnostics: Vec<shuck_parser::parser::ParseDiagnostic>,
    terminal_error: Option<&ShuckError>,
) -> Vec<RawDiagnostic> {
    let mut issues = parser_diagnostics
        .into_iter()
        .map(|diagnostic| SyntaxIssue {
            message: stable_message(&diagnostic.message),
            start: diagnostic.span.start.offset().min(source.len()),
            end: diagnostic.span.end.offset().min(source.len()),
            kind: "recovered",
        })
        .collect::<Vec<_>>();
    if let Some(ShuckError::Parse {
        message,
        line,
        column,
    }) = terminal_error
    {
        let start = line_column_offset(source, *line, *column);
        issues.push(SyntaxIssue {
            message: stable_message(message),
            start,
            end: crate::analysis::next_char_end(source.as_bytes(), start),
            kind: "fatal",
        });
    }
    issues.sort_by(|left, right| {
        (left.start, left.end, &left.message, left.kind).cmp(&(
            right.start,
            right.end,
            &right.message,
            right.kind,
        ))
    });
    issues.dedup_by(|left, right| {
        left.start == right.start && left.end == right.end && left.message == right.message
    });

    let truncated = issues.len() > MAX_DIAGNOSTICS;
    let retained = if truncated {
        MAX_DIAGNOSTICS.saturating_sub(1)
    } else {
        issues.len()
    };
    let lines = LineIndex::new(source.as_bytes());
    let mut occurrences = BTreeMap::<String, usize>::new();
    let mut diagnostics = Vec::with_capacity(retained.saturating_add(usize::from(truncated)));
    for issue in issues.iter().take(retained) {
        let anchor = crate::analysis::line_anchor(source.as_bytes(), issue.start);
        let occurrence_key = format!("{}:{anchor}", issue.message);
        let occurrence = occurrences.entry(occurrence_key).or_default();
        let entity_key = format!("syntax:{}:{anchor}:{}", issue.kind, *occurrence);
        *occurrence = occurrence.saturating_add(1);
        let mut evidence = parser_evidence(dialect);
        evidence.insert("errorKind".into(), serde_json::json!(issue.kind));
        diagnostics.push(RawDiagnostic {
            rule_id: "shell.syntax".into(),
            severity: Severity::Error,
            message: format!("Invalid Shell syntax: {}", issue.message),
            range: Some(lines.range(issue.start, issue.end)),
            entity_key,
            cause_key: format!(
                "parser:{SHELL_PARSER_VERSION}:{}:{}",
                issue.kind, issue.message
            ),
            evidence,
        });
    }
    if truncated {
        let mut evidence = parser_evidence(dialect);
        evidence.insert("actual".into(), serde_json::json!(issues.len()));
        evidence.insert("retained".into(), serde_json::json!(retained));
        evidence.insert("truncated".into(), serde_json::json!(true));
        diagnostics.push(RawDiagnostic {
            rule_id: "shell.syntax".into(),
            severity: Severity::Error,
            message: format!(
                "Shell parser produced {} errors; only the first {retained} are reported",
                issues.len()
            ),
            range: None,
            entity_key: "syntax:truncated".into(),
            cause_key: format!("parser:{SHELL_PARSER_VERSION}:truncated"),
            evidence,
        });
    }
    diagnostics
}

fn invalid_utf8_diagnostic(
    source: &[u8],
    error: std::str::Utf8Error,
    dialect: Dialect,
) -> RawDiagnostic {
    let start = error.valid_up_to();
    let end = start
        .saturating_add(error.error_len().unwrap_or(1))
        .min(source.len());
    let mut evidence = parser_evidence(dialect);
    evidence.insert("errorKind".into(), serde_json::json!("invalid_utf8"));
    RawDiagnostic {
        rule_id: "shell.syntax".into(),
        severity: Severity::Error,
        message: "Shell source is not valid UTF-8".into(),
        range: Some(LineIndex::new(source).range(start, end)),
        entity_key: format!(
            "syntax:invalid-utf8:{}",
            crate::analysis::line_anchor(source, start)
        ),
        cause_key: "invalid_utf8".into(),
        evidence,
    }
}

fn parser_evidence(dialect: Dialect) -> BTreeMap<String, serde_json::Value> {
    BTreeMap::from([
        ("dialect".into(), serde_json::json!(dialect.name())),
        ("hostOs".into(), serde_json::json!(std::env::consts::OS)),
        ("parser".into(), serde_json::json!(PARSER_NAME)),
        (
            "parserDialect".into(),
            serde_json::json!(dialect.parser_name()),
        ),
        (
            "parserVersion".into(),
            serde_json::json!(SHELL_PARSER_VERSION),
        ),
    ])
}

fn terminal_resource_limit(error: &ShuckError) -> bool {
    let ShuckError::Parse { message, .. } = error;
    let message = message.to_ascii_lowercase();
    message.contains("operation limit")
        || message.contains("depth limit")
        || message.contains("fuel")
}

fn stable_message(message: &str) -> String {
    message.replace(['\r', '\n'], " ")
}

fn line_column_offset(source: &str, line: usize, column: usize) -> usize {
    if line == 0 {
        return 0;
    }
    let line_start = source
        .split_inclusive('\n')
        .take(line.saturating_sub(1))
        .map(str::len)
        .sum::<usize>()
        .min(source.len());
    let column_offset = source[line_start..]
        .chars()
        .take(column.saturating_sub(1))
        .map(char::len_utf8)
        .sum::<usize>();
    line_start.saturating_add(column_offset).min(source.len())
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
}

impl LineIndex {
    fn new(source: &[u8]) -> Self {
        let mut starts = vec![0];
        starts.extend(
            source
                .iter()
                .enumerate()
                .filter(|(_, byte)| **byte == b'\n')
                .map(|(index, _)| index.saturating_add(1)),
        );
        Self {
            starts,
            source_len: source.len(),
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
            byte: u32::try_from(offset).unwrap_or(u32::MAX),
        }
    }

    fn range(&self, start: usize, end: usize) -> SourceRange {
        SourceRange {
            start: self.position(start),
            end: self.position(end),
        }
    }
}

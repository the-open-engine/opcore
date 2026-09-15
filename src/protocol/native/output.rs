use std::{
    collections::BTreeMap,
    env,
    path::{Component, Path},
    sync::Arc,
};

use ra_ap_rustc_lexer::{FrontmatterAllowed, Token, TokenKind, tokenize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    limits::{MAX_SOURCE_BYTES, MAX_STRUCTURAL_DEPTH},
    path::RepoPath,
};

use super::{
    NativeDiagnostic, NativeLocation, NativePosition, NativeRange, NativeSeverity, RULE, SOURCE,
};

const MAX_DIAGNOSTICS: usize = 4_096;
const MAX_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_CODE_BYTES: usize = 256;
const MAX_SPAN_CONTEXT_BYTES: usize = 16 * 1024;
const MAX_HELP_BYTES: usize = 16 * 1024;
const MAX_CHILDREN: usize = 32;
const MAX_STDERR_EXCERPT_BYTES: usize = 4 * 1024;
const MAX_SCOPES_PER_FILE: usize = 4_096;
const MAX_SCOPES_PER_REQUEST: usize = 65_536;
const PRIVATE_PATH_ENVIRONMENT: &[&str] =
    &["HOME", "CARGO_HOME", "RUSTUP_HOME", "TMPDIR", "TMP", "TEMP"];

pub(super) struct ParsedCargo {
    pub(super) diagnostics: Vec<NativeDiagnostic>,
    pub(super) error_count: usize,
    pub(super) build_finished: Option<bool>,
}

pub(super) fn parse(
    bytes: &[u8],
    workspace_root: &Path,
    target_root: &Path,
    source_files: &BTreeMap<RepoPath, Arc<[u8]>>,
) -> Result<ParsedCargo, ()> {
    let text = std::str::from_utf8(bytes).map_err(|_| ())?;
    let mut state = ParseState::default();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let value: Value = serde_json::from_str(line).map_err(|_| ())?;
        state.accept(&value, workspace_root, target_root, source_files)?;
    }
    state.diagnostics.sort_by(|left, right| {
        left.location
            .cmp(&right.location)
            .then_with(|| left.severity.cmp(&right.severity))
            .then_with(|| left.code.cmp(&right.code))
            .then_with(|| left.message.cmp(&right.message))
            .then_with(|| left.fingerprint.cmp(&right.fingerprint))
    });
    state.diagnostics.dedup();
    Ok(ParsedCargo {
        diagnostics: state.diagnostics,
        error_count: state.error_count,
        build_finished: state.build_finished,
    })
}

#[derive(Default)]
struct ParseState {
    diagnostics: Vec<NativeDiagnostic>,
    error_count: usize,
    build_finished: Option<bool>,
    semantic_scopes: SemanticScopes,
}

impl ParseState {
    fn accept(
        &mut self,
        value: &Value,
        workspace_root: &Path,
        target_root: &Path,
        source_files: &BTreeMap<RepoPath, Arc<[u8]>>,
    ) -> Result<(), ()> {
        let object = value.as_object().ok_or(())?;
        let reason = object.get("reason").and_then(Value::as_str).ok_or(())?;
        match reason {
            "compiler-message" => {
                self.accept_compiler(object, workspace_root, target_root, source_files)
            }
            "build-finished" => self.accept_finished(object),
            _ => Ok(()),
        }
    }

    fn accept_compiler(
        &mut self,
        object: &serde_json::Map<String, Value>,
        workspace_root: &Path,
        target_root: &Path,
        source_files: &BTreeMap<RepoPath, Arc<[u8]>>,
    ) -> Result<(), ()> {
        if self.diagnostics.len() >= MAX_DIAGNOSTICS {
            return Err(());
        }
        let Some(diagnostic) = compiler_diagnostic(
            object.get("message").ok_or(())?,
            workspace_root,
            target_root,
            &mut self.semantic_scopes,
            source_files,
        )?
        else {
            return Ok(());
        };
        self.error_count += usize::from(diagnostic.severity == NativeSeverity::Error);
        self.diagnostics.push(diagnostic);
        Ok(())
    }

    fn accept_finished(&mut self, object: &serde_json::Map<String, Value>) -> Result<(), ()> {
        let success = object.get("success").and_then(Value::as_bool).ok_or(())?;
        if self
            .build_finished
            .is_some_and(|previous| previous != success)
        {
            return Err(());
        }
        self.build_finished = Some(success);
        Ok(())
    }
}

fn compiler_diagnostic(
    value: &Value,
    workspace_root: &Path,
    target_root: &Path,
    semantic_scopes: &mut SemanticScopes,
    source_files: &BTreeMap<RepoPath, Arc<[u8]>>,
) -> Result<Option<NativeDiagnostic>, ()> {
    let Some(head) = diagnostic_head(value)? else {
        return Ok(None);
    };
    let message = diagnostic_message(
        head.raw_message,
        head.raw_code.as_deref(),
        workspace_root,
        target_root,
    );
    let (path, range, context) = diagnostic_location(head.object.get("spans"), workspace_root)?;
    let help = diagnostic_help(head.object, workspace_root, target_root)?;
    let semantic_key = semantic_scopes.key(
        &path,
        primary_byte_start(head.object.get("spans"))?,
        source_files,
    )?;
    let fingerprint = fingerprint(
        head.severity,
        head.raw_code.as_deref(),
        &message,
        &context,
        &semantic_key,
    );
    Ok(Some(NativeDiagnostic {
        code: format!("{SOURCE}/{RULE}"),
        severity: head.severity,
        source: SOURCE,
        message,
        help,
        location: NativeLocation { path, range },
        fingerprint,
    }))
}

struct DiagnosticHead<'a> {
    object: &'a serde_json::Map<String, Value>,
    severity: NativeSeverity,
    raw_message: &'a str,
    raw_code: Option<String>,
}

fn diagnostic_head(value: &Value) -> Result<Option<DiagnosticHead<'_>>, ()> {
    let object = value.as_object().ok_or(())?;
    let Some(severity) = severity(object.get("level"))? else {
        return Ok(None);
    };
    let raw_message = object.get("message").and_then(Value::as_str).ok_or(())?;
    if raw_message.len() > MAX_MESSAGE_BYTES {
        return Err(());
    }
    let raw_code = diagnostic_code(object.get("code"))?;
    Ok(Some(DiagnosticHead {
        object,
        severity,
        raw_message,
        raw_code,
    }))
}

fn severity(value: Option<&Value>) -> Result<Option<NativeSeverity>, ()> {
    match value.and_then(Value::as_str).ok_or(())? {
        "error" => Ok(Some(NativeSeverity::Error)),
        "warning" => Ok(Some(NativeSeverity::Warning)),
        "failure-note" | "note" | "help" => Ok(None),
        _ => Err(()),
    }
}

fn diagnostic_code(value: Option<&Value>) -> Result<Option<String>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let code = value
        .as_object()
        .and_then(|object| object.get("code"))
        .and_then(Value::as_str)
        .ok_or(())?;
    let valid = !code.is_empty()
        && code.len() <= MAX_CODE_BYTES
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b':'));
    valid.then(|| Some(code.to_owned())).ok_or(())
}

fn diagnostic_location(
    spans: Option<&Value>,
    workspace_root: &Path,
) -> Result<(String, Option<NativeRange>, String), ()> {
    let Some(spans) = spans else {
        return Ok(manifest_location());
    };
    let spans = spans.as_array().ok_or(())?;
    let Some(span) = selected_span(spans) else {
        return Ok(manifest_location());
    };
    let span = span.as_object().ok_or(())?;
    let raw_path = span.get("file_name").and_then(Value::as_str).ok_or(())?;
    let Some(path) = workspace_path(workspace_root, raw_path) else {
        return Ok(manifest_location());
    };
    Ok((path, span_range(span)?, span_context(span)?))
}

fn selected_span(spans: &[Value]) -> Option<&Value> {
    spans
        .iter()
        .find(|span| {
            span.as_object()
                .and_then(|object| object.get("is_primary"))
                .and_then(Value::as_bool)
                == Some(true)
        })
        .or_else(|| spans.first())
}

fn optional_spans(value: Option<&Value>) -> Result<Option<&[Value]>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    Ok(Some(value.as_array().map(Vec::as_slice).ok_or(())?))
}

fn selected_span_object(
    spans: Option<&Value>,
) -> Result<Option<&serde_json::Map<String, Value>>, ()> {
    let Some(spans) = optional_spans(spans)? else {
        return Ok(None);
    };
    Ok(selected_span(spans).and_then(Value::as_object))
}

fn primary_byte_start(spans: Option<&Value>) -> Result<Option<usize>, ()> {
    let Some(span) = selected_span_object(spans)? else {
        return Ok(None);
    };
    span.get("byte_start").map_or(Ok(None), |value| {
        value
            .as_u64()
            .and_then(|offset| usize::try_from(offset).ok())
            .map(Some)
            .ok_or(())
    })
}

fn manifest_location() -> (String, Option<NativeRange>, String) {
    ("Cargo.toml".to_owned(), None, String::new())
}

fn span_context(span: &serde_json::Map<String, Value>) -> Result<String, ()> {
    let Some(lines) = span.get("text") else {
        return Ok(String::new());
    };
    let lines = lines.as_array().ok_or(())?;
    let mut context = String::new();
    for line in lines {
        let text = line
            .as_object()
            .and_then(|line| line.get("text"))
            .and_then(Value::as_str)
            .ok_or(())?;
        if context.len().saturating_add(text.len()) > MAX_SPAN_CONTEXT_BYTES {
            return Err(());
        }
        context.push_str(text);
        context.push('\n');
    }
    Ok(context.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn span_range(span: &serde_json::Map<String, Value>) -> Result<Option<NativeRange>, ()> {
    let fields = ["line_start", "column_start", "line_end", "column_end"];
    if fields.iter().all(|field| !span.contains_key(*field)) {
        return Ok(None);
    }
    let start = NativePosition {
        line: span_number(span, "line_start")?.saturating_sub(1),
        char: span_number(span, "column_start")?.saturating_sub(1),
    };
    let end = NativePosition {
        line: span_number(span, "line_end")?.saturating_sub(1),
        char: span_number(span, "column_end")?.saturating_sub(1),
    };
    (end >= start)
        .then_some(Some(NativeRange { start, end }))
        .ok_or(())
}

fn span_number(span: &serde_json::Map<String, Value>, field: &str) -> Result<u32, ()> {
    span.get(field)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or(())
}

fn workspace_path(workspace_root: &Path, raw_path: &str) -> Option<String> {
    let normalized = raw_path.replace('\\', "/");
    let raw_path = Path::new(&normalized);
    let relative = if raw_path.is_absolute() {
        raw_path.strip_prefix(workspace_root).ok()?
    } else {
        raw_path
    };
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?.to_owned()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn diagnostic_message(
    message: &str,
    rustc_code: Option<&str>,
    workspace_root: &Path,
    target_root: &Path,
) -> String {
    let normalized = normalized_message(message, workspace_root, target_root);
    rustc_code.map_or(normalized.clone(), |code| format!("{code}: {normalized}"))
}

fn diagnostic_help(
    diagnostic: &serde_json::Map<String, Value>,
    workspace_root: &Path,
    target_root: &Path,
) -> Result<Option<String>, ()> {
    let mut parts = Vec::new();
    if let Some(label) = selected_span_label(diagnostic.get("spans"))? {
        parts.push(label);
    }
    for child in diagnostic_children(diagnostic)? {
        append_child_help(&mut parts, child, workspace_root, target_root)?;
    }
    finish_help(&parts)
}

fn diagnostic_children(diagnostic: &serde_json::Map<String, Value>) -> Result<&[Value], ()> {
    let Some(value) = diagnostic.get("children") else {
        return Ok(&[]);
    };
    let children = value.as_array().map(Vec::as_slice).ok_or(())?;
    if children.len() > MAX_CHILDREN {
        return Err(());
    }
    Ok(children)
}

fn append_child_help(
    parts: &mut Vec<String>,
    child: &Value,
    workspace_root: &Path,
    target_root: &Path,
) -> Result<(), ()> {
    let child = child.as_object().ok_or(())?;
    let level = child.get("level").and_then(Value::as_str).ok_or(())?;
    if !matches!(level, "note" | "help" | "failure-note") {
        return Ok(());
    }
    let message = child.get("message").and_then(Value::as_str).ok_or(())?;
    if message.len() > MAX_HELP_BYTES {
        return Err(());
    }
    let message = normalized_message(message, workspace_root, target_root);
    if !message.is_empty() {
        parts.push(format!("{level}: {message}"));
    }
    if let Some(replacement) = suggested_replacement(child.get("spans"))? {
        parts.push(format!("suggested replacement: {replacement}"));
    }
    Ok(())
}

fn finish_help(parts: &[String]) -> Result<Option<String>, ()> {
    if parts.is_empty() {
        return Ok(None);
    }
    let help = parts.join("; ");
    (help.len() <= MAX_HELP_BYTES)
        .then_some(Some(help))
        .ok_or(())
}

fn selected_span_label(spans: Option<&Value>) -> Result<Option<String>, ()> {
    let Some(span) = selected_span_object(spans)? else {
        return Ok(None);
    };
    optional_bounded_text(span.get("label"), MAX_HELP_BYTES)
}

fn suggested_replacement(spans: Option<&Value>) -> Result<Option<String>, ()> {
    let Some(spans) = optional_spans(spans)? else {
        return Ok(None);
    };
    for span in spans {
        let span = span.as_object().ok_or(())?;
        if let Some(replacement) =
            optional_bounded_text(span.get("suggested_replacement"), MAX_HELP_BYTES)?
        {
            return Ok(Some(replacement));
        }
    }
    Ok(None)
}

fn optional_bounded_text(value: Option<&Value>, max_bytes: usize) -> Result<Option<String>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let text = value.as_str().ok_or(())?;
    if text.len() > max_bytes {
        return Err(());
    }
    let text = clean_text(text);
    Ok((!text.is_empty()).then_some(text))
}

fn normalized_message(message: &str, workspace_root: &Path, target_root: &Path) -> String {
    let mut message = clean_text(message);
    for path in [workspace_root, target_root] {
        if let Some(path) = path.to_str() {
            message = message.replace(path, "<private>");
            message = message.replace(&path.replace('\\', "/"), "<private>");
        }
    }
    for key in PRIVATE_PATH_ENVIRONMENT {
        if let Some(path) = env::var_os(key).and_then(|path| path.into_string().ok())
            && !path.is_empty()
        {
            message = message.replace(&path, "<private>");
            message = message.replace(&path.replace('\\', "/"), "<private>");
        }
    }
    clean_text(&message)
}

fn clean_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || character.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Default)]
struct SemanticScopes {
    files: BTreeMap<String, Vec<ScopeRange>>,
    total_scopes: usize,
}

impl SemanticScopes {
    fn key(
        &mut self,
        path: &str,
        byte_start: Option<usize>,
        source_files: &BTreeMap<RepoPath, Arc<[u8]>>,
    ) -> Result<String, ()> {
        let Some(byte_start) = byte_start else {
            return Ok(format!("path:{path}"));
        };
        if Path::new(path).extension() != Some(std::ffi::OsStr::new("rs")) {
            return Ok(format!("path:{path}"));
        }
        if !self.files.contains_key(path) {
            let scopes = RepoPath::from_protocol(path)
                .ok()
                .and_then(|path| source_files.get(&path))
                .and_then(|bytes| scope_ranges(bytes).ok())
                .unwrap_or_default();
            self.total_scopes = self.total_scopes.checked_add(scopes.len()).ok_or(())?;
            if self.total_scopes > MAX_SCOPES_PER_REQUEST {
                return Err(());
            }
            self.files.insert(path.to_owned(), scopes);
        }
        let scope = self
            .files
            .get(path)
            .and_then(|scopes| {
                scopes
                    .iter()
                    .filter(|scope| scope.start <= byte_start && byte_start <= scope.end)
                    .min_by_key(|scope| scope.end.saturating_sub(scope.start))
            })
            .map_or("file", |scope| scope.key.as_str());
        Ok(format!("path:{path}/scope:{scope}"))
    }
}

struct ScopeRange {
    start: usize,
    end: usize,
    key: String,
}

struct OpenScope {
    named: bool,
    start: usize,
    key: String,
}

fn scope_ranges(bytes: &[u8]) -> Result<Vec<ScopeRange>, ()> {
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err(());
    }
    let source = std::str::from_utf8(bytes).map_err(|_| ())?;
    let mut collector = ScopeCollector::new(source);
    for token in tokenize(source, FrontmatterAllowed::No) {
        collector.accept(&token)?;
    }
    collector.finish()
}

struct ScopeCollector<'a> {
    source: &'a str,
    ranges: Vec<ScopeRange>,
    scopes: Vec<OpenScope>,
    names: Vec<String>,
    header: Vec<(String, usize)>,
    offset: usize,
}

impl<'a> ScopeCollector<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source,
            ranges: Vec::new(),
            scopes: Vec::new(),
            names: Vec::new(),
            header: Vec::new(),
            offset: 0,
        }
    }

    fn accept(&mut self, token: &Token) -> Result<(), ()> {
        let start = self.offset;
        self.advance(token.len)?;
        self.accept_kind(token.kind, start)
    }

    fn advance(&mut self, length: u32) -> Result<(), ()> {
        self.offset = self
            .offset
            .checked_add(usize::try_from(length).map_err(|_| ())?)
            .ok_or(())?;
        Ok(())
    }

    fn accept_kind(&mut self, kind: TokenKind, start: usize) -> Result<(), ()> {
        match kind {
            TokenKind::Ident | TokenKind::RawIdent => self.accept_identifier(start),
            TokenKind::OpenBrace => self.open_scope(start),
            TokenKind::CloseBrace => self.close_scope(),
            TokenKind::Semi => self.finish_statement(),
            _ => Ok(()),
        }
    }

    fn accept_identifier(&mut self, start: usize) -> Result<(), ()> {
        if self.header.len() >= 256 {
            return Ok(());
        }
        let identifier = self.source.get(start..self.offset).ok_or(())?.to_owned();
        self.header.push((identifier, start));
        Ok(())
    }

    fn open_scope(&mut self, start: usize) -> Result<(), ()> {
        if self.scopes.len() >= MAX_STRUCTURAL_DEPTH {
            return Err(());
        }
        let (named, scope_start, key) =
            if let Some((component, declaration_start)) = scope_declaration(&self.header) {
                self.names.push(component);
                (true, declaration_start, self.names.join("/"))
            } else {
                (false, start, String::new())
            };
        self.scopes.push(OpenScope {
            named,
            start: scope_start,
            key,
        });
        self.header.clear();
        Ok(())
    }

    fn close_scope(&mut self) -> Result<(), ()> {
        let Some(scope) = self.scopes.pop() else {
            return Err(());
        };
        finish_scope(scope, self.offset, &mut self.names, &mut self.ranges)?;
        self.header.clear();
        Ok(())
    }

    fn finish_statement(&mut self) -> Result<(), ()> {
        if let Some((component, start)) = scope_declaration(&self.header) {
            let mut key = self.names.join("/");
            if !key.is_empty() {
                key.push('/');
            }
            key.push_str(&component);
            push_scope(
                &mut self.ranges,
                ScopeRange {
                    start,
                    end: self.offset,
                    key,
                },
            )?;
        }
        self.header.clear();
        Ok(())
    }

    fn finish(mut self) -> Result<Vec<ScopeRange>, ()> {
        while let Some(scope) = self.scopes.pop() {
            finish_scope(scope, self.offset, &mut self.names, &mut self.ranges)?;
        }
        Ok(self.ranges)
    }
}

fn scope_declaration(header: &[(String, usize)]) -> Option<(String, usize)> {
    for (index, (keyword, start)) in header.iter().enumerate().rev() {
        match keyword.as_str() {
            "fn" | "mod" | "trait" | "struct" | "enum" | "union" | "type" | "const" | "static" => {
                let name = header.get(index + 1)?.0.trim_start_matches("r#");
                return Some((format!("{keyword}:{name}"), *start));
            }
            "impl" => {
                let signature = header[index + 1..]
                    .iter()
                    .map(|(token, _)| token.as_str())
                    .collect::<Vec<_>>()
                    .join(":");
                if !signature.is_empty() {
                    return Some((format!("impl:{signature}"), *start));
                }
            }
            _ => {}
        }
    }
    None
}

fn finish_scope(
    scope: OpenScope,
    end: usize,
    names: &mut Vec<String>,
    ranges: &mut Vec<ScopeRange>,
) -> Result<(), ()> {
    if scope.named {
        names.pop().ok_or(())?;
        push_scope(
            ranges,
            ScopeRange {
                start: scope.start,
                end,
                key: scope.key,
            },
        )?;
    }
    Ok(())
}

fn push_scope(ranges: &mut Vec<ScopeRange>, scope: ScopeRange) -> Result<(), ()> {
    if ranges.len() >= MAX_SCOPES_PER_FILE {
        return Err(());
    }
    ranges.push(scope);
    Ok(())
}

fn fingerprint(
    severity: NativeSeverity,
    rustc_code: Option<&str>,
    message: &str,
    context: &str,
    semantic_key: &str,
) -> String {
    let severity = match severity {
        NativeSeverity::Error => "error",
        NativeSeverity::Warning => "warning",
    };
    let mut digest = Sha256::new();
    for part in [
        SOURCE,
        RULE,
        severity,
        rustc_code.unwrap_or("rustc"),
        message,
        context,
        semantic_key,
    ] {
        digest.update(u64::try_from(part.len()).unwrap_or(u64::MAX).to_be_bytes());
        digest.update(part.as_bytes());
    }
    format!("sha256:{}", hex::encode(digest.finalize()))
}

pub(super) fn unavailable(stderr: &[u8], stdout: &[u8]) -> bool {
    let stderr = String::from_utf8_lossy(stderr);
    let stdout = String::from_utf8_lossy(stdout);
    let output = format!("{stderr}\n{stdout}").to_ascii_lowercase();
    [
        "no matching package named",
        "failed to download",
        "attempting to make an http request, but --offline was specified",
        "attempting to make an http request, but cargo is operating in offline mode",
        "failed to get `",
        "no default toolchain configured",
        "toolchain is not installed",
        "is not installed for the toolchain",
        "rustc is not installed",
        "linker `",
    ]
    .iter()
    .any(|needle| output.contains(needle))
}

pub(super) fn stderr_excerpt(
    stderr: &[u8],
    workspace_root: &Path,
    target_root: &Path,
) -> Option<String> {
    let normalized = normalized_message(
        &String::from_utf8_lossy(stderr),
        workspace_root,
        target_root,
    );
    if normalized.is_empty() {
        return None;
    }
    Some(truncate_utf8(&normalized, MAX_STDERR_EXCERPT_BYTES))
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes.saturating_sub(3);
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    format!("{}...", &value[..end])
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn compiler_messages_become_sorted_asp_diagnostics() {
        let warning = cargo_message("warning", "unused value", "unused_variables", "src/z.rs", 4);
        let error = cargo_message("error", "mismatched types", "E0308", "src/a.rs", 2);
        let finished = json!({ "reason": "build-finished", "success": false });
        let output = format!("{warning}\n{error}\n{finished}\n");
        let parsed = parse_messages(&output);

        assert_eq!(parsed.error_count, 1);
        assert_eq!(parsed.build_finished, Some(false));
        assert_eq!(parsed.diagnostics[0].location.path, "src/a.rs");
        assert_eq!(parsed.diagnostics[0].location.range.unwrap().start.line, 1);
        assert_eq!(
            parsed.diagnostics[1].message,
            "unused_variables: unused value"
        );
        assert_eq!(parsed.diagnostics[0].code, "opcore-rust-native/cargo-check");
        assert!(parsed.diagnostics[0].fingerprint.starts_with("sha256:"));
    }

    #[test]
    fn malformed_json_is_incomplete_input() {
        assert!(
            parse(
                b"not json\n",
                Path::new("/private/workspace"),
                Path::new("/private/target"),
                &BTreeMap::new(),
            )
            .is_err()
        );
    }

    #[test]
    fn duplicate_target_diagnostics_are_collapsed_and_failure_notes_are_ignored() {
        let error = cargo_message("error", "mismatched types", "E0308", "src/a.rs", 2);
        let failure_note = cargo_message(
            "failure-note",
            "For more information about this error, try `rustc --explain E0308`.",
            "E0308",
            "src/a.rs",
            2,
        );
        let output = format!("{error}\n{error}\n{failure_note}\n");
        let parsed = parse_messages(&output);

        assert_eq!(parsed.error_count, 2);
        assert_eq!(parsed.diagnostics.len(), 1);
        assert_eq!(parsed.diagnostics[0].message, "E0308: mismatched types");
    }

    #[test]
    fn paths_outside_workspace_do_not_escape_the_assessment() {
        let message = cargo_message(
            "error",
            "dependency failed",
            "E0001",
            "/registry/dependency/src/lib.rs",
            1,
        );
        let parsed = parse(
            format!("{message}\n").as_bytes(),
            Path::new("/private/workspace"),
            Path::new("/private/target"),
            &BTreeMap::new(),
        )
        .expect("valid Cargo output");

        assert_eq!(parsed.diagnostics[0].location.path, "Cargo.toml");
        assert_eq!(parsed.diagnostics[0].location.range, None);
    }

    #[test]
    fn offline_dependency_failure_is_unavailable() {
        assert!(unavailable(
            b"error: no matching package named `missing` found",
            b""
        ));
    }

    #[test]
    fn fingerprint_is_path_bound_and_distinguishes_source_context() {
        let source = "fn sample() { let value = broken; }\n";
        let source_files = source_map(&[("src/a.rs", source), ("src/b.rs", source)]);
        let byte_start = source.find("broken").unwrap();
        let mut first = cargo_message("error", "mismatched types", "E0308", "src/a.rs", 2);
        first["message"]["spans"][0]["byte_start"] = json!(byte_start);
        let mut renamed = cargo_message("error", "mismatched types", "E0308", "src/b.rs", 20);
        renamed["message"]["spans"][0]["byte_start"] = json!(byte_start);
        let mut different = renamed.clone();
        different["message"]["spans"][0]["text"][0]["text"] = json!("let other = also_broken;");
        let first_fingerprint = parsed_fingerprint(&first, &source_files);
        let renamed_fingerprint = parsed_fingerprint(&renamed, &source_files);
        let different_fingerprint = parsed_fingerprint(&different, &source_files);

        assert_ne!(first_fingerprint, renamed_fingerprint);
        assert_ne!(renamed_fingerprint, different_fingerprint);
    }

    #[test]
    fn fingerprint_distinguishes_enclosing_rust_items() {
        let source = "fn alpha() { let value = broken; }\nfn beta() { let value = broken; }\n";
        let source_files = source_map(&[("src/lib.rs", source)]);
        let fingerprint_at = |offset: usize| {
            let mut message = cargo_message("error", "mismatched types", "E0308", "src/lib.rs", 1);
            message["message"]["spans"][0]["byte_start"] = json!(offset);
            parsed_fingerprint(&message, &source_files)
        };

        assert_ne!(
            fingerprint_at(source.find("broken").unwrap()),
            fingerprint_at(source.rfind("broken").unwrap())
        );
    }

    #[test]
    fn bounded_child_guidance_is_preserved() {
        let mut message = cargo_message("error", "mismatched types", "E0308", "src/a.rs", 2);
        message["message"]["spans"][0]["label"] = json!("expected usize, found &str");
        message["message"]["children"] = json!([{
            "level": "help",
            "message": "convert the value",
            "spans": [{ "suggested_replacement": "value.len()" }]
        }]);
        let parsed = parse(
            format!("{message}\n").as_bytes(),
            Path::new("/private/workspace"),
            Path::new("/private/target"),
            &BTreeMap::new(),
        )
        .unwrap();

        assert_eq!(
            parsed.diagnostics[0].help.as_deref(),
            Some(
                "expected usize, found &str; help: convert the value; suggested replacement: value.len()"
            )
        );
    }

    #[test]
    fn stderr_excerpt_is_bounded_and_redacts_private_roots() {
        let stderr = format!("error in {}\n{}", "/private/workspace", "x".repeat(8_192));
        let excerpt = stderr_excerpt(
            stderr.as_bytes(),
            Path::new("/private/workspace"),
            Path::new("/private/target"),
        )
        .unwrap();

        assert!(!excerpt.contains("/private/workspace"));
        assert!(excerpt.len() <= MAX_STDERR_EXCERPT_BYTES);
    }

    fn parsed_fingerprint(message: &Value, source_files: &BTreeMap<RepoPath, Arc<[u8]>>) -> String {
        parse(
            format!("{message}\n").as_bytes(),
            Path::new("/private/workspace"),
            Path::new("/private/target"),
            source_files,
        )
        .unwrap()
        .diagnostics
        .pop()
        .unwrap()
        .fingerprint
    }

    fn parse_messages(output: &str) -> ParsedCargo {
        parse(
            output.as_bytes(),
            Path::new("/private/workspace"),
            Path::new("/private/target"),
            &BTreeMap::new(),
        )
        .expect("valid Cargo output")
    }

    fn source_map(entries: &[(&str, &str)]) -> BTreeMap<RepoPath, Arc<[u8]>> {
        entries
            .iter()
            .map(|(path, source)| {
                (
                    RepoPath::from_protocol(path).unwrap(),
                    Arc::<[u8]>::from(source.as_bytes()),
                )
            })
            .collect()
    }

    fn cargo_message(level: &str, message: &str, code: &str, file: &str, line: u32) -> Value {
        json!({
            "reason": "compiler-message",
            "message": {
                "level": level,
                "message": message,
                "code": { "code": code },
                "children": [],
                "spans": [{
                    "file_name": file,
                    "is_primary": true,
                    "line_start": line,
                    "column_start": 1,
                    "line_end": line,
                    "column_end": 2,
                    "text": [{
                        "text": "let value = broken;",
                        "highlight_start": 1,
                        "highlight_end": 2
                    }]
                }]
            }
        })
    }
}

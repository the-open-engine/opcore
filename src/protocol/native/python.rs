use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    limits::MAX_DIAGNOSTICS,
    path::RepoPath,
    protocol::asp::{PYTHON_NATIVE_PROVIDER_ID, PYTHON_NATIVE_RULE},
    source::has_extension,
};

use super::{
    NativeCheckRequest, NativeCheckResult, NativeDiagnostic, NativeFingerprintInput,
    NativeLocation, NativePosition, NativeRange, NativeSeverity, NativeStatus, common_evidence,
    complete_result, diagnostic_fingerprint, evaluation_window, output_detail,
    private_temp_environment, process, resolve_diagnostic_path, sort_diagnostics,
};

const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_RULE_BYTES: usize = 256;
const MAX_SOURCE_ARGUMENT_BYTES: usize = 256 * 1024;

pub(super) fn evaluate(request: &NativeCheckRequest<'_>) -> NativeCheckResult {
    PythonEvaluator::new(request).run()
}

pub(super) fn applicable(files: &BTreeMap<RepoPath, Arc<[u8]>>) -> bool {
    has_python(files)
}

#[derive(Clone, Copy)]
enum PythonBackend {
    Pyright,
    Mypy,
}

impl PythonBackend {
    const fn name(self) -> &'static str {
        match self {
            Self::Pyright => "pyright",
            Self::Mypy => "mypy",
        }
    }
}

struct PythonEvaluator<'request, 'input> {
    request: &'request NativeCheckRequest<'input>,
    started: Instant,
    deadline: Instant,
    backend: PythonBackend,
    fallback_path: RepoPath,
    source_paths: Vec<String>,
    files_analyzed: Option<u64>,
    captured_output_bytes: usize,
}

impl<'request, 'input> PythonEvaluator<'request, 'input> {
    fn new(request: &'request NativeCheckRequest<'input>) -> Self {
        let (started, deadline) = evaluation_window(request.limits.timeout);
        Self {
            request,
            started,
            deadline,
            backend: python_backend(request.tool_program),
            fallback_path: fallback_path(request.source_files),
            source_paths: python_source_paths(request.source_files),
            files_analyzed: None,
            captured_output_bytes: 0,
        }
    }

    fn run(mut self) -> NativeCheckResult {
        if !has_python(self.request.source_files) {
            return self.finish(
                NativeStatus::NotApplicable,
                Vec::new(),
                "the candidate has no Python source",
                None,
                true,
            );
        }
        if self.request.cancel.is_cancelled() {
            return self.finish(
                NativeStatus::Cancelled,
                Vec::new(),
                "Python-native evaluation was cancelled",
                None,
                false,
            );
        }
        if self.request.identity.runtime_path().is_none() {
            return self.finish(
                NativeStatus::Unavailable,
                Vec::new(),
                "Python-native could not bind a Python interpreter",
                None,
                false,
            );
        }
        let argument_bytes = self
            .source_paths
            .iter()
            .map(String::len)
            .fold(0_usize, usize::saturating_add);
        if argument_bytes > MAX_SOURCE_ARGUMENT_BYTES {
            return self.finish(
                NativeStatus::Incomplete,
                Vec::new(),
                format!(
                    "selected Python paths exceed the {MAX_SOURCE_ARGUMENT_BYTES}-byte command argument limit"
                ),
                None,
                false,
            );
        }
        let outcome = match self.backend {
            PythonBackend::Pyright => self.run_pyright(),
            PythonBackend::Mypy => self.run_mypy(),
        };
        if self
            .request
            .identity
            .verify(
                self.request.tool_program,
                self.request.cancel,
                self.deadline,
            )
            .is_err()
        {
            self.finish(
                if self.request.cancel.is_cancelled() {
                    NativeStatus::Cancelled
                } else {
                    NativeStatus::Incomplete
                },
                Vec::new(),
                "the Python type checker or selected interpreter changed or could not be verified during evaluation",
                None,
                false,
            )
        } else {
            outcome
        }
    }

    fn run_pyright(&mut self) -> NativeCheckResult {
        let environment = python_environment(self.request.workspace_root);
        let interpreter = match self.interpreter() {
            Ok(interpreter) => interpreter,
            Err(result) => return result,
        };
        let argv = pyright_argv(interpreter, &self.source_paths);
        let execution = match self.execute(&argv, &environment) {
            Ok(execution) => execution,
            Err(result) => return result,
        };
        let parsed = match parse_pyright(&execution.stdout, self.output_context()) {
            Ok(parsed) => parsed,
            Err(detail) => return self.parse_failure(detail, &execution),
        };
        self.files_analyzed = Some(parsed.files_analyzed);
        if parsed.files_analyzed < self.source_paths.len() as u64 {
            return self.finish(
                NativeStatus::Incomplete,
                parsed.diagnostics,
                format!(
                    "Pyright analyzed only {} of {} explicitly selected Python files",
                    parsed.files_analyzed,
                    self.source_paths.len()
                ),
                execution.exit_status.code(),
                false,
            );
        }
        let accepted_exit =
            accepted_checker_exit(execution.exit_status.code(), !parsed.diagnostics.is_empty());
        if !accepted_exit {
            return self.finish(
                NativeStatus::Incomplete,
                Vec::new(),
                output_detail(
                    "Pyright failed outside its diagnostic exit contract",
                    &execution.stdout,
                    &execution.stderr,
                ),
                execution.exit_status.code(),
                false,
            );
        }
        self.complete(parsed.diagnostics, execution.exit_status.code())
    }

    fn run_mypy(&mut self) -> NativeCheckResult {
        let Ok(cache) = tempfile::Builder::new()
            .prefix("opcore-mypy-cache-")
            .tempdir_in(
                self.request
                    .workspace_root
                    .parent()
                    .unwrap_or(self.request.workspace_root),
            )
        else {
            return self.finish(
                NativeStatus::Incomplete,
                Vec::new(),
                "Python-native could not allocate an ephemeral mypy cache",
                None,
                false,
            );
        };
        let environment = python_environment(self.request.workspace_root);
        let interpreter = match self.interpreter() {
            Ok(interpreter) => interpreter,
            Err(result) => return result,
        };
        let argv = mypy_argv(cache.path(), interpreter, &self.source_paths);
        let execution = match self.execute(&argv, &environment) {
            Ok(execution) => execution,
            Err(result) => return result,
        };
        let diagnostics = match parse_mypy(&execution.stdout, self.output_context()) {
            Ok(diagnostics) => diagnostics,
            Err(detail) => return self.parse_failure(detail, &execution),
        };
        let accepted_exit =
            accepted_checker_exit(execution.exit_status.code(), !diagnostics.is_empty());
        if accepted_exit {
            self.complete(diagnostics, execution.exit_status.code())
        } else {
            self.finish(
                NativeStatus::Incomplete,
                Vec::new(),
                output_detail(
                    "mypy failed without a supported diagnostic",
                    &execution.stdout,
                    &execution.stderr,
                ),
                execution.exit_status.code(),
                false,
            )
        }
    }

    fn complete(
        &self,
        mut diagnostics: Vec<NativeDiagnostic>,
        exit_code: Option<i32>,
    ) -> NativeCheckResult {
        sort_diagnostics(&mut diagnostics);
        if diagnostics.len() > MAX_DIAGNOSTICS {
            return self.finish(
                NativeStatus::Incomplete,
                Vec::new(),
                format!("Python diagnostics exceed the {MAX_DIAGNOSTICS}-finding limit"),
                exit_code,
                false,
            );
        }
        let missing_imports = diagnostics
            .iter()
            .filter(|diagnostic| environment_sensitive_import(diagnostic))
            .count();
        if missing_imports > 0 && self.request.identity.runtime_source() == Some("ambient") {
            return self.finish(
                NativeStatus::Incomplete,
                diagnostics,
                format!(
                    "Python-native found {missing_imports} unresolved import diagnostic(s) while \
                     using the ambient interpreter; select a project environment with \
                     OPCORE_PYTHON or a context-local .venv"
                ),
                exit_code,
                false,
            );
        }
        self.finish(
            if diagnostics.is_empty() {
                NativeStatus::Clean
            } else {
                NativeStatus::Findings
            },
            diagnostics,
            "",
            exit_code,
            true,
        )
    }

    fn execute(
        &mut self,
        argv: &[String],
        environment: &[(OsString, OsString)],
    ) -> Result<process::ToolExecution, NativeCheckResult> {
        match process::run_tool(
            self.request,
            self.request.workspace_root,
            argv,
            environment,
            self.deadline,
        ) {
            Ok(execution) => {
                self.captured_output_bytes = execution.captured_output_bytes();
                Ok(execution)
            }
            Err(failure) => {
                self.captured_output_bytes = failure.captured_output_bytes;
                Err(self.finish(
                    failure.status,
                    Vec::new(),
                    failure.detail,
                    failure.exit_code,
                    false,
                ))
            }
        }
    }

    fn output_context(&self) -> PythonOutputContext<'_> {
        PythonOutputContext {
            workspace_root: self.request.workspace_root,
            files: self.request.source_files,
            fallback: &self.fallback_path,
        }
    }

    fn interpreter(&self) -> Result<&str, NativeCheckResult> {
        self.request
            .identity
            .runtime_path()
            .and_then(Path::to_str)
            .ok_or_else(|| {
                self.finish(
                    NativeStatus::Unavailable,
                    Vec::new(),
                    "the selected Python interpreter path is not valid Unicode",
                    None,
                    false,
                )
            })
    }

    fn parse_failure(
        &self,
        detail: &'static str,
        execution: &process::ToolExecution,
    ) -> NativeCheckResult {
        self.finish(
            NativeStatus::Incomplete,
            Vec::new(),
            output_detail(detail, &execution.stdout, &execution.stderr),
            execution.exit_status.code(),
            false,
        )
    }

    fn finish(
        &self,
        status: NativeStatus,
        diagnostics: Vec<NativeDiagnostic>,
        detail: impl Into<String>,
        exit_code: Option<i32>,
        comparison_safe: bool,
    ) -> NativeCheckResult {
        let mut evidence = common_evidence(
            self.request,
            self.started,
            self.captured_output_bytes,
            exit_code,
        );
        evidence.insert("backend".into(), json!(self.backend.name()));
        evidence.insert(
            "argv".into(),
            json!(match self.backend {
                PythonBackend::Pyright => [
                    "--outputjson",
                    "--warnings",
                    "--threads",
                    "1",
                    "--pythonpath",
                    "<python-interpreter>",
                    "<explicit-source-paths>",
                ]
                .into_iter()
                .map(str::to_owned)
                .collect(),
                PythonBackend::Mypy => vec!["fixed-mypy-project-check".to_owned()],
            }),
        );
        evidence.insert("selectedSourceFiles".into(), json!(self.source_paths.len()));
        evidence.insert(
            "sourceArgumentsDigest".into(),
            json!(source_arguments_digest(&self.source_paths)),
        );
        evidence.insert("filesAnalyzed".into(), json!(self.files_analyzed));
        evidence.insert(
            "pythonEnvironment".into(),
            json!({
                "source": self.request.identity.runtime_source(),
                "interpreterDigest": self.request.identity.runtime.as_ref().map(|runtime| runtime.digest.as_str()),
                "markerDigest": self.request.identity.runtime.as_ref()
                    .and_then(|runtime| runtime.marker.as_ref())
                    .map(|(_, digest)| digest.as_str())
            }),
        );
        evidence.insert("reportedDiagnostics".into(), json!(diagnostics.len()));
        evidence.insert(
            "unresolvedImportDiagnostics".into(),
            json!(
                diagnostics
                    .iter()
                    .filter(|diagnostic| environment_sensitive_import(diagnostic))
                    .count()
            ),
        );
        evidence.insert("cache".into(), json!("ephemeral-or-disabled"));
        complete_result(
            status,
            diagnostics,
            detail.into(),
            evidence,
            comparison_safe,
        )
    }
}

fn python_backend(tool: &Path) -> PythonBackend {
    let configured_mypy = env::var_os("OPCORE_MYPY").map(PathBuf::from);
    if configured_mypy.as_deref() == Some(tool)
        || tool
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.to_ascii_lowercase().contains("mypy"))
    {
        PythonBackend::Mypy
    } else {
        PythonBackend::Pyright
    }
}

fn accepted_checker_exit(exit_code: Option<i32>, has_diagnostics: bool) -> bool {
    exit_code == Some(0) || (exit_code == Some(1) && has_diagnostics)
}

fn pyright_argv(interpreter: &str, source_paths: &[String]) -> Vec<String> {
    [
        "--outputjson",
        "--warnings",
        "--threads",
        "1",
        "--pythonpath",
        interpreter,
    ]
    .into_iter()
    .map(str::to_owned)
    .chain(source_paths.iter().cloned())
    .collect()
}

fn mypy_argv(cache: &Path, interpreter: &str, source_paths: &[String]) -> Vec<String> {
    let mut argv = vec![
        "--show-column-numbers".into(),
        "--show-error-codes".into(),
        "--hide-error-context".into(),
        "--no-color-output".into(),
        "--no-error-summary".into(),
        "--no-pretty".into(),
        "--cache-dir".into(),
        cache.to_string_lossy().into_owned(),
        "--python-executable".into(),
        interpreter.to_owned(),
    ];
    argv.extend(source_paths.iter().cloned());
    argv
}

fn environment_sensitive_import(diagnostic: &NativeDiagnostic) -> bool {
    [
        "reportMissingImports",
        "reportMissingModuleSource",
        "reportMissingTypeStubs",
        "import-not-found",
        "import-untyped",
    ]
    .iter()
    .any(|rule| diagnostic.code.ends_with(&format!("/{rule}")))
}

fn python_source_paths(files: &BTreeMap<RepoPath, Arc<[u8]>>) -> Vec<String> {
    files
        .keys()
        .filter(|path| is_python(path))
        .map(ToString::to_string)
        .collect()
}

fn source_arguments_digest(paths: &[String]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"opcore.python-source-arguments.v1");
    for path in paths {
        digest.update(u64::try_from(path.len()).unwrap_or(u64::MAX).to_be_bytes());
        digest.update(path.as_bytes());
    }
    format!("sha256:{}", hex::encode(digest.finalize()))
}

fn python_environment(workspace_root: &Path) -> Vec<(OsString, OsString)> {
    let mut environment = vec![
        (OsString::from("LC_ALL"), OsString::from("C")),
        (OsString::from("NO_COLOR"), OsString::from("1")),
        (OsString::from("PYTHONUTF8"), OsString::from("1")),
        (OsString::from("MYPY_FORCE_COLOR"), OsString::from("0")),
    ];
    environment.extend(private_temp_environment(workspace_root));
    environment
}

#[derive(Clone, Copy)]
struct PythonOutputContext<'a> {
    workspace_root: &'a Path,
    files: &'a BTreeMap<RepoPath, Arc<[u8]>>,
    fallback: &'a RepoPath,
}

fn parse_pyright(
    output: &[u8],
    context: PythonOutputContext<'_>,
) -> Result<ParsedPyrightOutput, &'static str> {
    let document: Value = serde_json::from_slice(output)
        .map_err(|_| "Pyright returned malformed JSON diagnostics")?;
    let diagnostics = document
        .get("generalDiagnostics")
        .and_then(Value::as_array)
        .ok_or("Pyright omitted generalDiagnostics")?;
    let summary = document
        .get("summary")
        .and_then(Value::as_object)
        .ok_or("Pyright omitted its completion summary")?;
    if diagnostics.len() > MAX_DIAGNOSTICS {
        return Err("Pyright diagnostics exceed the configured finding limit");
    }
    let (parsed, counts) = collect_pyright(diagnostics, context)?;
    if !pyright_summary_matches(summary, counts) {
        return Err("Pyright diagnostic counts contradict its completion summary");
    }
    let files_analyzed =
        summary_count(summary, "filesAnalyzed").ok_or("Pyright omitted its analyzed-file count")?;
    Ok(ParsedPyrightOutput {
        diagnostics: parsed,
        files_analyzed,
    })
}

struct ParsedPyrightOutput {
    diagnostics: Vec<NativeDiagnostic>,
    files_analyzed: u64,
}

#[derive(Clone, Copy, Default)]
struct PyrightCounts {
    errors: u64,
    warnings: u64,
    information: u64,
}

fn collect_pyright(
    diagnostics: &[Value],
    context: PythonOutputContext<'_>,
) -> Result<(Vec<NativeDiagnostic>, PyrightCounts), &'static str> {
    let mut parsed = Vec::new();
    let mut counts = PyrightCounts::default();
    for diagnostic in diagnostics {
        match parse_pyright_diagnostic(diagnostic, context)? {
            ParsedPyright::Finding(finding) => {
                match finding.severity {
                    NativeSeverity::Error => counts.errors = counts.errors.saturating_add(1),
                    NativeSeverity::Warning => {
                        counts.warnings = counts.warnings.saturating_add(1);
                    }
                }
                parsed.push(finding);
            }
            ParsedPyright::Information => {
                counts.information = counts.information.saturating_add(1);
            }
        }
    }
    Ok((parsed, counts))
}

fn pyright_summary_matches(
    summary: &serde_json::Map<String, Value>,
    counts: PyrightCounts,
) -> bool {
    summary_count(summary, "errorCount") == Some(counts.errors)
        && summary_count(summary, "warningCount") == Some(counts.warnings)
        && summary_count(summary, "informationCount") == Some(counts.information)
}

enum ParsedPyright {
    Finding(NativeDiagnostic),
    Information,
}

fn parse_pyright_diagnostic(
    value: &Value,
    context: PythonOutputContext<'_>,
) -> Result<ParsedPyright, &'static str> {
    let object = value
        .as_object()
        .ok_or("Pyright returned a non-object diagnostic")?;
    let severity = match object.get("severity").and_then(Value::as_str) {
        Some("error") => NativeSeverity::Error,
        Some("warning") => NativeSeverity::Warning,
        Some("information") => return Ok(ParsedPyright::Information),
        _ => return Err("Pyright returned an unsupported diagnostic severity"),
    };
    let message = bounded_string(object.get("message"), MAX_MESSAGE_BYTES, "Pyright message")?;
    let raw_file = bounded_string(
        object.get("file"),
        crate::path::MAX_REPOSITORY_PATH_BYTES * 2,
        "Pyright file",
    )?;
    let path = resolve_diagnostic_path(&raw_file, context.workspace_root, context.files)
        .unwrap_or_else(|| context.fallback.clone());
    let range = pyright_range(object.get("range"))?;
    let raw_rule = object
        .get("rule")
        .and_then(Value::as_str)
        .filter(|rule| !rule.is_empty() && rule.len() <= MAX_RULE_BYTES)
        .unwrap_or("type-check");
    let rule = sanitize_rule(raw_rule);
    let code = format!("{PYTHON_NATIVE_RULE}/{rule}");
    let fingerprint = diagnostic_fingerprint(NativeFingerprintInput {
        domain: "python-native-diagnostic/v1",
        code: &code,
        message: &message,
        path: &path,
        range: Some(range),
        files: context.files,
    });
    Ok(ParsedPyright::Finding(NativeDiagnostic {
        code,
        severity,
        source: PYTHON_NATIVE_PROVIDER_ID,
        message,
        help: None,
        location: NativeLocation {
            path: path.to_string(),
            range: Some(range),
        },
        fingerprint,
    }))
}

fn pyright_range(value: Option<&Value>) -> Result<NativeRange, &'static str> {
    let object = value
        .and_then(Value::as_object)
        .ok_or("Pyright diagnostic omitted its range")?;
    Ok(NativeRange {
        start: pyright_position(object.get("start"))?,
        end: pyright_position(object.get("end"))?,
    })
}

fn pyright_position(value: Option<&Value>) -> Result<NativePosition, &'static str> {
    let object = value
        .and_then(Value::as_object)
        .ok_or("Pyright diagnostic contained an invalid position")?;
    let line = object
        .get("line")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or("Pyright line is outside provider bounds")?;
    let character = object
        .get("character")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or("Pyright character is outside provider bounds")?;
    Ok(NativePosition {
        line,
        char: character,
    })
}

fn parse_mypy(
    output: &[u8],
    context: PythonOutputContext<'_>,
) -> Result<Vec<NativeDiagnostic>, &'static str> {
    let mut diagnostics = Vec::new();
    for line in String::from_utf8_lossy(output).lines() {
        if line.trim().is_empty()
            || line.starts_with("Success: no issues found in ")
            || recognized_mypy_note(line)
        {
            continue;
        }
        let Some(diagnostic) = parse_mypy_line(line, context) else {
            return Err("mypy returned an unsupported output line");
        };
        diagnostics.push(diagnostic);
    }
    Ok(diagnostics)
}

fn recognized_mypy_note(line: &str) -> bool {
    let Some((location, message)) = line.split_once(": note: ") else {
        return false;
    };
    !message.is_empty()
        && message.len() <= MAX_MESSAGE_BYTES
        && location
            .rsplit_once(':')
            .is_some_and(|(_, line)| line.parse::<u32>().is_ok())
}

fn parse_mypy_line(line: &str, context: PythonOutputContext<'_>) -> Option<NativeDiagnostic> {
    let head = mypy_head(line)?;
    if head.message.len() > MAX_MESSAGE_BYTES {
        return None;
    }
    let path = resolve_diagnostic_path(head.raw_path, context.workspace_root, context.files)
        .unwrap_or_else(|| context.fallback.clone());
    Some(mypy_diagnostic(&path, &head, context.files))
}

struct MypyHead<'a> {
    raw_path: &'a str,
    line: u32,
    character: u32,
    severity: NativeSeverity,
    message: &'a str,
}

fn mypy_head(line: &str) -> Option<MypyHead<'_>> {
    let fields = line.splitn(5, ':').collect::<Vec<_>>();
    let [raw_path, raw_line, raw_character, raw_severity, raw_message] = fields.as_slice() else {
        return None;
    };
    let line = one_based(raw_line.trim())?;
    let character = one_based(raw_character.trim())?;
    let severity = match raw_severity.trim() {
        "error" => NativeSeverity::Error,
        "warning" => NativeSeverity::Warning,
        _ => return None,
    };
    Some(MypyHead {
        raw_path: raw_path.trim(),
        line,
        character,
        severity,
        message: raw_message.trim(),
    })
}

fn mypy_diagnostic(
    path: &RepoPath,
    head: &MypyHead<'_>,
    files: &BTreeMap<RepoPath, Arc<[u8]>>,
) -> NativeDiagnostic {
    let position = NativePosition {
        line: head.line,
        char: head.character,
    };
    let range = NativeRange {
        start: position,
        end: position,
    };
    let (message, raw_rule) = mypy_rule(head.message);
    let code = format!("{PYTHON_NATIVE_RULE}/{}", sanitize_rule(raw_rule));
    let fingerprint = diagnostic_fingerprint(NativeFingerprintInput {
        domain: "python-native-diagnostic/v1",
        code: &code,
        message,
        path,
        range: Some(range),
        files,
    });
    NativeDiagnostic {
        code,
        severity: head.severity,
        source: PYTHON_NATIVE_PROVIDER_ID,
        message: message.to_owned(),
        help: None,
        location: NativeLocation {
            path: path.to_string(),
            range: Some(range),
        },
        fingerprint,
    }
}

fn mypy_rule(message: &str) -> (&str, &str) {
    let Some(open) = message.rfind("  [") else {
        return (message, "type-check");
    };
    let Some(rule) = message
        .get(open + 3..)
        .and_then(|rule| rule.strip_suffix(']'))
    else {
        return (message, "type-check");
    };
    (message.get(..open).unwrap_or(message), rule)
}

fn fallback_path(files: &BTreeMap<RepoPath, Arc<[u8]>>) -> RepoPath {
    for preferred in ["pyproject.toml", "pyrightconfig.json", "mypy.ini"] {
        if let Ok(path) = RepoPath::from_protocol(preferred)
            && files.contains_key(&path)
        {
            return path;
        }
    }
    files
        .keys()
        .find(|path| is_python(path))
        .cloned()
        .unwrap_or_else(RepoPath::request_marker)
}

fn has_python(files: &BTreeMap<RepoPath, Arc<[u8]>>) -> bool {
    files.keys().any(is_python)
}

fn is_python(path: &RepoPath) -> bool {
    has_extension(path.as_bytes(), b".py") || has_extension(path.as_bytes(), b".pyi")
}

fn bounded_string(
    value: Option<&Value>,
    limit: usize,
    label: &'static str,
) -> Result<String, &'static str> {
    let value = value.and_then(Value::as_str).ok_or(label)?;
    if value.len() > limit {
        return Err(label);
    }
    Ok(value.to_owned())
}

fn summary_count(summary: &serde_json::Map<String, Value>, field: &str) -> Option<u64> {
    summary.get(field).and_then(Value::as_u64)
}

fn sanitize_rule(rule: &str) -> String {
    let sanitized = rule
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "type-check".into()
    } else {
        sanitized
    }
}

fn one_based(value: &str) -> Option<u32> {
    value.parse::<u32>().ok()?.checked_sub(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::asp::ProviderProfile;

    use super::super::test_support::NativeHarness;

    const CLEAN_PYRIGHT: &str = r#"#!/bin/sh
cat <<'JSON'
{"generalDiagnostics":[],"summary":{
  "filesAnalyzed":1,"errorCount":0,"warningCount":0,"informationCount":0
}}
JSON
exit 0
"#;

    fn run_python(
        entries: &[(&str, &str)],
        tool_name: &str,
        tool_source: &str,
        cancelled: bool,
    ) -> NativeCheckResult {
        let harness = NativeHarness::new(
            ProviderProfile::PythonNative,
            entries,
            tool_name,
            tool_source,
            cancelled,
        );
        evaluate(&harness.request())
    }

    fn fixture() -> (RepoPath, BTreeMap<RepoPath, Arc<[u8]>>) {
        let path = RepoPath::from_protocol("example.py").expect("fixture path");
        let files = BTreeMap::from([(
            path.clone(),
            Arc::<[u8]>::from(b"value: str = 1\n".as_slice()),
        )]);
        (path, files)
    }

    fn context<'a>(
        path: &'a RepoPath,
        files: &'a BTreeMap<RepoPath, Arc<[u8]>>,
    ) -> PythonOutputContext<'a> {
        PythonOutputContext {
            workspace_root: Path::new("/tmp/workspace"),
            files,
            fallback: path,
        }
    }

    #[test]
    fn parses_pyright_json_with_summary_validation() {
        let (path, files) = fixture();
        let output = serde_json::to_vec(&json!({
            "generalDiagnostics": [{
                "file": "/tmp/workspace/example.py",
                "severity": "error",
                "message": "number is not assignable to str",
                "range": {
                    "start": { "line": 0, "character": 13 },
                    "end": { "line": 0, "character": 14 }
                },
                "rule": "reportAssignmentType"
            }],
            "summary": {
                "filesAnalyzed": 1,
                "errorCount": 1,
                "warningCount": 0,
                "informationCount": 0
            }
        }))
        .expect("fixture json");
        let diagnostics = parse_pyright(&output, context(&path, &files)).expect("valid output");
        assert_eq!(diagnostics.diagnostics.len(), 1);
        assert_eq!(diagnostics.diagnostics[0].location.path, "example.py");
    }

    #[test]
    fn parses_plain_mypy_diagnostics() {
        let (path, files) = fixture();
        let output =
            b"example.py:1:14: error: Incompatible types  [assignment]\nexample.py:1: note: Hint\n";
        let diagnostics = parse_mypy(output, context(&path, &files)).expect("valid output");
        let diagnostic = &diagnostics[0];
        assert_eq!(diagnostic.location.path, "example.py");
        assert!(diagnostic.code.ends_with("/assignment"));
        assert!(parse_mypy(b"unexpected\n", context(&path, &files)).is_err());
    }

    #[test]
    fn python_evaluator_accepts_structured_pyright_findings_and_clean_output() {
        let findings = run_python(
            &[("app.py", "value: str = 1\n")],
            "pyright",
            r#"#!/bin/sh
cat <<'JSON'
{
  "generalDiagnostics": [{
    "file": "app.py",
    "severity": "warning",
    "message": "simulated assignment failure",
    "range": {
      "start": {"line": 0, "character": 13},
      "end": {"line": 0, "character": 14}
    },
    "rule": "reportAssignmentType"
  }, {
    "file": "app.py",
    "severity": "information",
    "message": "informational context",
    "range": {
      "start": {"line": 0, "character": 0},
      "end": {"line": 0, "character": 1}
    }
  }],
  "summary": {"filesAnalyzed": 1, "errorCount": 0, "warningCount": 1, "informationCount": 1}
}
JSON
exit 1
"#,
            false,
        );
        assert_eq!(findings.status, NativeStatus::Findings);
        assert_eq!(findings.diagnostics.len(), 1);
        assert_eq!(findings.diagnostics[0].severity, NativeSeverity::Warning);
        assert_eq!(findings.evidence["backend"], "pyright");
        assert_eq!(
            findings.evidence["argv"],
            json!([
                "--outputjson",
                "--warnings",
                "--threads",
                "1",
                "--pythonpath",
                "<python-interpreter>",
                "<explicit-source-paths>"
            ])
        );
        assert!(
            findings.evidence["sourceArgumentsDigest"]
                .as_str()
                .is_some_and(|digest| digest.starts_with("sha256:"))
        );
        assert!(!findings.evidence["argv"].to_string().contains("app.py"));

        let clean = run_python(
            &[("package/__init__.pyi", "value: str\n")],
            "pyright",
            CLEAN_PYRIGHT,
            false,
        );
        assert_eq!(clean.status, NativeStatus::Clean);
        assert!(clean.comparison_safe);
    }

    #[test]
    fn python_evaluator_supports_mypy_and_rejects_malformed_contracts() {
        let mypy = run_python(
            &[("app.py", "value: str = 1\n")],
            "mypy",
            r"#!/bin/sh
echo 'app.py:1:14: error: Incompatible types  [assignment]'
echo 'app.py:1: note: Hint'
exit 1
",
            false,
        );
        assert_eq!(mypy.status, NativeStatus::Findings);
        assert_eq!(mypy.evidence["backend"], "mypy");
        assert!(mypy.diagnostics[0].code.ends_with("/assignment"));

        let malformed = run_python(
            &[("app.py", "pass\n")],
            "pyright",
            "#!/bin/sh\necho 'not json'\nexit 0\n",
            false,
        );
        assert_eq!(malformed.status, NativeStatus::Incomplete);
        assert!(
            malformed
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("malformed JSON"))
        );

        let invalid_exit = run_python(
            &[("app.py", "pass\n")],
            "pyright",
            &CLEAN_PYRIGHT.replace("exit 0", "exit 2"),
            false,
        );
        assert_eq!(invalid_exit.status, NativeStatus::Incomplete);
    }

    #[test]
    fn python_evaluator_reports_applicability_and_cancellation_exactly() {
        let absent = run_python(
            &[("pyproject.toml", "[tool.pyright]\n")],
            "pyright",
            "#!/bin/sh\nexit 0\n",
            false,
        );
        assert_eq!(absent.status, NativeStatus::NotApplicable);
        assert!(absent.comparison_safe);

        let cancelled = run_python(
            &[("app.py", "pass\n")],
            "pyright",
            "#!/bin/sh\nexit 0\n",
            true,
        );
        assert_eq!(cancelled.status, NativeStatus::Cancelled);
        assert!(!cancelled.comparison_safe);
    }

    #[test]
    fn python_evaluator_rejects_partial_pyright_file_coverage() {
        let result = run_python(
            &[("one.py", "pass\n"), ("two.py", "pass\n")],
            "pyright",
            CLEAN_PYRIGHT,
            false,
        );

        assert_eq!(result.status, NativeStatus::Incomplete);
        assert!(
            result
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("1 of 2"))
        );
        assert_eq!(result.evidence["selectedSourceFiles"], 2);
        assert_eq!(result.evidence["filesAnalyzed"], 1);
    }

    #[test]
    fn ambient_unresolved_imports_make_python_coverage_incomplete() {
        let result = run_python(
            &[("app.py", "import unavailable_package\n")],
            "pyright",
            r#"#!/bin/sh
cat <<'JSON'
{
  "generalDiagnostics": [{
    "file": "app.py",
    "severity": "error",
    "message": "Import 'unavailable_package' could not be resolved",
    "range": {
      "start": {"line": 0, "character": 7},
      "end": {"line": 0, "character": 26}
    },
    "rule": "reportMissingImports"
  }],
  "summary": {"filesAnalyzed": 1, "errorCount": 1, "warningCount": 0, "informationCount": 0}
}
JSON
exit 1
"#,
            false,
        );

        assert_eq!(result.status, NativeStatus::Incomplete);
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(result.evidence["unresolvedImportDiagnostics"], 1);
        assert!(
            result
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("ambient interpreter"))
        );
        assert!(!result.comparison_safe);
    }
}

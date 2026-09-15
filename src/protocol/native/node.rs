use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

use serde_json::json;

use crate::{
    limits::MAX_DIAGNOSTICS,
    path::RepoPath,
    protocol::asp::{NODE_NATIVE_PROVIDER_ID, NODE_NATIVE_RULE},
    source::has_extension,
};

use super::{
    NativeCheckRequest, NativeCheckResult, NativeDiagnostic, NativeExecutionIdentity,
    NativeFingerprintInput, NativeLocation, NativePosition, NativeRange, NativeSeverity,
    NativeStatus, common_evidence, complete_result, diagnostic_fingerprint, evaluation_window,
    output_detail, private_temp_environment, process, resolve_diagnostic_path, sort_diagnostics,
};

const MAX_CONFIGS: usize = 256;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

pub(super) fn evaluate(request: &NativeCheckRequest<'_>) -> NativeCheckResult {
    NodeEvaluator::new(request).run()
}

pub(super) fn applicable(files: &BTreeMap<RepoPath, Arc<[u8]>>) -> bool {
    files.keys().any(|path| path.as_bytes() == b"package.json")
        && has_npm_lock(files)
        && !type_script_configs(files).is_empty()
}

struct NodeEvaluator<'request, 'input> {
    request: &'request NativeCheckRequest<'input>,
    started: Instant,
    deadline: Instant,
    configs: Vec<String>,
    captured_output_bytes: usize,
    compiler: Option<String>,
    compiler_digest: Option<String>,
    covered_files: BTreeSet<RepoPath>,
}

impl<'request, 'input> NodeEvaluator<'request, 'input> {
    fn new(request: &'request NativeCheckRequest<'input>) -> Self {
        let (started, deadline) = evaluation_window(request.limits.timeout);
        Self {
            request,
            started,
            deadline,
            configs: type_script_configs(request.source_files),
            captured_output_bytes: 0,
            compiler: None,
            compiler_digest: None,
            covered_files: BTreeSet::new(),
        }
    }

    fn run(mut self) -> NativeCheckResult {
        if let Some(result) = self.preflight() {
            return result;
        }
        let environment = native_environment(self.request.workspace_root);
        let outcome = match self.install(&environment) {
            Ok(()) => self.check_projects(&environment),
            Err(result) => result,
        };
        if cleanup_node_modules(self.request.workspace_root, self.request.source_files).is_err() {
            return self.finish(
                NativeStatus::Incomplete,
                Vec::new(),
                "Node-native could not remove generated node_modules content",
                outcome_exit_code(&outcome),
                false,
            );
        }
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
            self.identity_failure(
                "the npm executable or Node runtime changed or could not be verified during evaluation"
                    .into(),
            )
        } else {
            outcome
        }
    }

    fn preflight(&self) -> Option<NativeCheckResult> {
        let has_package = self
            .request
            .source_files
            .keys()
            .any(|path| path.as_bytes() == b"package.json");
        if !has_package || self.configs.is_empty() {
            return Some(self.finish(
                NativeStatus::NotApplicable,
                Vec::new(),
                "the candidate has no root package.json and TypeScript project",
                None,
                true,
            ));
        }
        if self.request.identity.runtime_path().is_none() {
            return Some(self.finish(
                NativeStatus::Unavailable,
                Vec::new(),
                "Node-native could not bind the PATH-selected Node runtime",
                None,
                false,
            ));
        }
        if self.configs.len() > MAX_CONFIGS {
            return Some(self.finish(
                NativeStatus::Incomplete,
                Vec::new(),
                format!("TypeScript project count exceeds the {MAX_CONFIGS}-config limit"),
                None,
                false,
            ));
        }
        if contains_tracked_node_modules(self.request.source_files) {
            return Some(self.finish(
                NativeStatus::Incomplete,
                Vec::new(),
                "tracked node_modules content is outside the Node-native materialization profile",
                None,
                false,
            ));
        }
        if !has_npm_lock(self.request.source_files) {
            return Some(self.finish(
                NativeStatus::NotApplicable,
                Vec::new(),
                "Node-native requires a root npm package-lock.json or npm-shrinkwrap.json",
                None,
                true,
            ));
        }
        self.request.cancel.is_cancelled().then(|| {
            self.finish(
                NativeStatus::Cancelled,
                Vec::new(),
                "Node-native evaluation was cancelled",
                None,
                false,
            )
        })
    }

    fn install(&mut self, environment: &[(OsString, OsString)]) -> Result<(), NativeCheckResult> {
        let execution = process::run_tool(
            self.request,
            self.request.workspace_root,
            &npm_argv(),
            environment,
            self.deadline,
        )
        .map_err(|failure| {
            self.captured_output_bytes = failure.captured_output_bytes;
            self.finish(
                failure.status,
                Vec::new(),
                failure.detail,
                failure.exit_code,
                false,
            )
        })?;
        self.captured_output_bytes = execution.captured_output_bytes();
        if execution.exit_status.success() {
            return Ok(());
        }
        let unavailable = npm_unavailable(&execution.stdout, &execution.stderr);
        Err(self.finish(
            if unavailable {
                NativeStatus::Unavailable
            } else {
                NativeStatus::Incomplete
            },
            Vec::new(),
            output_detail(
                if unavailable {
                    "npm could not satisfy the locked dependency graph from its offline cache"
                } else {
                    "npm ci failed before TypeScript checking"
                },
                &execution.stdout,
                &execution.stderr,
            ),
            execution.exit_status.code(),
            false,
        ))
    }

    fn check_projects(&mut self, environment: &[(OsString, OsString)]) -> NativeCheckResult {
        let (compiler, identity) = match self.compiler_identity() {
            Ok(value) => value,
            Err(result) => return result,
        };
        let diagnostics = match self.collect_projects(&compiler, &identity, environment) {
            Ok(diagnostics) => diagnostics,
            Err(result) => return result,
        };
        if identity
            .verify_tool(&compiler, self.request.cancel, self.deadline)
            .is_err()
        {
            return self.identity_failure(
                "the TypeScript compiler changed or could not be verified during evaluation".into(),
            );
        }
        self.finish_projects(diagnostics)
    }

    fn compiler_identity(
        &mut self,
    ) -> Result<(PathBuf, NativeExecutionIdentity), NativeCheckResult> {
        let Some(compiler) = local_tsc(self.request.workspace_root) else {
            return Err(self.finish(
                NativeStatus::Unavailable,
                Vec::new(),
                "the locked npm installation does not provide a root project-local tsc",
                Some(0),
                false,
            ));
        };
        let identity = match NativeExecutionIdentity::capture(
            self.request.profile,
            &compiler,
            self.request.cancel,
            self.deadline,
        ) {
            Ok(identity) => identity,
            Err(detail) => return Err(self.identity_failure(detail)),
        };
        self.compiler = Some("node_modules/.bin/tsc".into());
        self.compiler_digest = Some(identity.tool_digest.clone());
        Ok((compiler, identity))
    }

    fn collect_projects(
        &mut self,
        compiler: &Path,
        identity: &NativeExecutionIdentity,
        environment: &[(OsString, OsString)],
    ) -> Result<Vec<NativeDiagnostic>, NativeCheckResult> {
        let mut diagnostics = Vec::new();
        for config in self.configs.clone() {
            let mut project = self.check_project(&config, compiler, identity, environment)?;
            diagnostics.append(&mut project.diagnostics);
            self.covered_files.append(&mut project.files);
            if diagnostics.len() > MAX_DIAGNOSTICS {
                return Err(self.finish(
                    NativeStatus::Incomplete,
                    Vec::new(),
                    format!("TypeScript diagnostics exceed the {MAX_DIAGNOSTICS}-finding limit"),
                    Some(1),
                    false,
                ));
            }
        }
        Ok(diagnostics)
    }

    fn finish_projects(&self, mut diagnostics: Vec<NativeDiagnostic>) -> NativeCheckResult {
        sort_diagnostics(&mut diagnostics);
        let clean = diagnostics.is_empty();
        self.finish(
            if clean {
                NativeStatus::Clean
            } else {
                NativeStatus::Findings
            },
            diagnostics,
            "",
            Some(i32::from(!clean)),
            true,
        )
    }

    fn check_project(
        &mut self,
        config: &str,
        compiler: &Path,
        identity: &NativeExecutionIdentity,
        environment: &[(OsString, OsString)],
    ) -> Result<ProjectCheck, NativeCheckResult> {
        let argv = tsc_argv(config);
        let compiler_request = NativeCheckRequest {
            profile: self.request.profile,
            workspace_root: self.request.workspace_root,
            project_root: self.request.project_root,
            source_files: self.request.source_files,
            tool_program: compiler,
            identity,
            cancel: self.request.cancel,
            limits: self.request.limits,
        };
        let execution = process::run_tool(
            &compiler_request,
            self.request.workspace_root,
            &argv,
            environment,
            self.deadline,
        )
        .map_err(|failure| {
            self.captured_output_bytes = self
                .captured_output_bytes
                .saturating_add(failure.captured_output_bytes);
            self.finish(
                failure.status,
                Vec::new(),
                failure.detail,
                failure.exit_code,
                false,
            )
        })?;
        self.captured_output_bytes = self
            .captured_output_bytes
            .saturating_add(execution.captured_output_bytes());
        if self.captured_output_bytes > self.request.limits.max_output_bytes {
            return Err(self.finish(
                NativeStatus::Incomplete,
                Vec::new(),
                "Node-native cumulative output exceeded the configured byte limit",
                execution.exit_status.code(),
                false,
            ));
        }
        let diagnostics = parse_tsc_output(
            &execution.stdout,
            &execution.stderr,
            self.request.workspace_root,
            self.request.source_files,
            config,
        );
        if execution.exit_status.success()
            || (execution.exit_status.code().is_some() && !diagnostics.is_empty())
        {
            Ok(ProjectCheck {
                diagnostics,
                files: listed_project_files(
                    &execution.stdout,
                    self.request.workspace_root,
                    self.request.source_files,
                ),
            })
        } else {
            Err(self.finish(
                NativeStatus::Incomplete,
                Vec::new(),
                output_detail(
                    "tsc failed without a supported diagnostic",
                    &execution.stdout,
                    &execution.stderr,
                ),
                execution.exit_status.code(),
                false,
            ))
        }
    }

    fn identity_failure(&self, detail: String) -> NativeCheckResult {
        self.finish(
            if self.request.cancel.is_cancelled() {
                NativeStatus::Cancelled
            } else {
                NativeStatus::Incomplete
            },
            Vec::new(),
            detail,
            None,
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
        let install_argv = npm_argv();
        let mut evidence = common_evidence(
            self.request,
            self.started,
            self.captured_output_bytes,
            exit_code,
        );
        evidence.insert("installArgv".into(), json!(install_argv));
        evidence.insert("compiler".into(), json!(self.compiler));
        evidence.insert("compilerDigest".into(), json!(self.compiler_digest));
        evidence.insert("configs".into(), json!(self.configs));
        evidence.insert("coveredSourceFiles".into(), json!(self.covered_files.len()));
        evidence.insert(
            "unconfiguredTypeScriptSourceFiles".into(),
            json!(
                type_script_source_files(self.request.source_files)
                    .difference(&self.covered_files)
                    .count()
            ),
        );
        evidence.insert(
            "unconfiguredJavaScriptSourceFiles".into(),
            json!(
                node_source_files(self.request.source_files)
                    .difference(&self.covered_files)
                    .filter(|path| !is_type_script(path))
                    .count()
            ),
        );
        evidence.insert(
            "selectedSourceFiles".into(),
            json!(node_source_files(self.request.source_files).len()),
        );
        evidence.insert(
            "locked".into(),
            json!(has_npm_lock(self.request.source_files)),
        );
        evidence.insert("npmOffline".into(), json!(true));
        evidence.insert("lifecycleScripts".into(), json!(false));
        evidence.insert("dependencyTree".into(), json!("ephemeral"));
        complete_result(
            status,
            diagnostics,
            detail.into(),
            evidence,
            comparison_safe,
        )
    }
}

fn npm_argv() -> Vec<String> {
    [
        "ci",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-update-notifier",
        "--color=false",
        "--progress=false",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

fn tsc_argv(config: &str) -> Vec<String> {
    [
        "--project",
        config,
        "--noEmit",
        "--pretty",
        "false",
        "--listFiles",
        "--incremental",
        "false",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

fn native_environment(workspace_root: &Path) -> Vec<(OsString, OsString)> {
    let mut environment = vec![
        (OsString::from("CI"), OsString::from("true")),
        (OsString::from("LC_ALL"), OsString::from("C")),
        (OsString::from("NO_COLOR"), OsString::from("1")),
        (OsString::from("NPM_CONFIG_OFFLINE"), OsString::from("true")),
        (
            OsString::from("NPM_CONFIG_IGNORE_SCRIPTS"),
            OsString::from("true"),
        ),
        (OsString::from("NPM_CONFIG_AUDIT"), OsString::from("false")),
        (OsString::from("NPM_CONFIG_FUND"), OsString::from("false")),
        (
            OsString::from("NPM_CONFIG_UPDATE_NOTIFIER"),
            OsString::from("false"),
        ),
    ];
    environment.extend(private_temp_environment(workspace_root));
    environment
}

fn type_script_configs(files: &BTreeMap<RepoPath, Arc<[u8]>>) -> Vec<String> {
    files
        .keys()
        .filter_map(|path| {
            let value = path.as_utf8()?;
            value.rsplit('/').next().and_then(|name| {
                (name == "tsconfig.json"
                    || (name.starts_with("tsconfig.")
                        && Path::new(name)
                            .extension()
                            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))))
                .then(|| value.to_owned())
            })
        })
        .collect()
}

struct ProjectCheck {
    diagnostics: Vec<NativeDiagnostic>,
    files: BTreeSet<RepoPath>,
}

fn node_source_files(files: &BTreeMap<RepoPath, Arc<[u8]>>) -> BTreeSet<RepoPath> {
    files
        .keys()
        .filter(|path| {
            let bytes = path.as_bytes();
            [
                b".js".as_slice(),
                b".jsx",
                b".mjs",
                b".cjs",
                b".ts",
                b".tsx",
                b".mts",
                b".cts",
            ]
            .iter()
            .any(|suffix| has_extension(bytes, suffix))
        })
        .cloned()
        .collect()
}

fn type_script_source_files(files: &BTreeMap<RepoPath, Arc<[u8]>>) -> BTreeSet<RepoPath> {
    files
        .keys()
        .filter(|path| is_type_script(path))
        .cloned()
        .collect()
}

fn is_type_script(path: &RepoPath) -> bool {
    [b".ts".as_slice(), b".tsx", b".mts", b".cts"]
        .iter()
        .any(|suffix| has_extension(path.as_bytes(), suffix))
}

fn listed_project_files(
    stdout: &[u8],
    workspace_root: &Path,
    source_files: &BTreeMap<RepoPath, Arc<[u8]>>,
) -> BTreeSet<RepoPath> {
    let selected = node_source_files(source_files);
    String::from_utf8_lossy(stdout)
        .lines()
        .filter_map(|line| resolve_diagnostic_path(line.trim(), workspace_root, source_files))
        .filter(|path| selected.contains(path))
        .collect()
}

fn has_npm_lock(files: &BTreeMap<RepoPath, Arc<[u8]>>) -> bool {
    files.keys().any(|path| {
        matches!(
            path.as_bytes(),
            b"package-lock.json" | b"npm-shrinkwrap.json"
        )
    })
}

fn contains_tracked_node_modules(files: &BTreeMap<RepoPath, Arc<[u8]>>) -> bool {
    files.keys().any(|path| {
        path.as_bytes()
            .split(|byte| *byte == b'/')
            .any(|part| part == b"node_modules")
    })
}

fn local_tsc(workspace_root: &Path) -> Option<PathBuf> {
    workspace_root
        .join("node_modules/.bin/tsc")
        .canonicalize()
        .ok()
        .filter(|path| path.is_file())
}

fn cleanup_node_modules(
    workspace_root: &Path,
    files: &BTreeMap<RepoPath, Arc<[u8]>>,
) -> std::io::Result<()> {
    let paths = files
        .keys()
        .filter(|path| path.as_bytes().ends_with(b"package.json"))
        .filter_map(|path| path.to_path_buf().parent().map(Path::to_owned))
        .map(|parent| workspace_root.join(parent).join("node_modules"))
        .chain(std::iter::once(workspace_root.join("node_modules")))
        .collect::<BTreeSet<_>>();
    let mut paths = paths.into_iter().collect::<Vec<_>>();
    paths.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for path in paths {
        match fs::remove_dir_all(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn npm_unavailable(stdout: &[u8], stderr: &[u8]) -> bool {
    let output = format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    )
    .to_ascii_lowercase();
    [
        "enotcached",
        "cache mode is 'only-if-cached'",
        "could not resolve dependency",
        "no cached response available",
    ]
    .iter()
    .any(|needle| output.contains(needle))
}

fn parse_tsc_output(
    stdout: &[u8],
    stderr: &[u8],
    workspace_root: &Path,
    source_files: &BTreeMap<RepoPath, Arc<[u8]>>,
    config: &str,
) -> Vec<NativeDiagnostic> {
    let stdout = String::from_utf8_lossy(stdout);
    let stderr = String::from_utf8_lossy(stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .filter_map(|line| parse_tsc_line(line, workspace_root, source_files, config))
        .collect()
}

fn parse_tsc_line(
    line: &str,
    workspace_root: &Path,
    source_files: &BTreeMap<RepoPath, Arc<[u8]>>,
    config: &str,
) -> Option<NativeDiagnostic> {
    let line = line.trim();
    let (raw_path, range, diagnostic) =
        if let Some((prefix, diagnostic)) = line.split_once(": error TS") {
            let (raw_path, range) = tsc_location(prefix);
            (raw_path, range, diagnostic)
        } else {
            (config, None, line.strip_prefix("error TS")?)
        };
    let (raw_code, message) = diagnostic.split_once(':')?;
    if raw_code.is_empty()
        || !raw_code.bytes().all(|byte| byte.is_ascii_digit())
        || message.len() > MAX_MESSAGE_BYTES
    {
        return None;
    }
    let fallback = RepoPath::from_protocol(config).ok()?;
    let path = resolve_diagnostic_path(raw_path, workspace_root, source_files).unwrap_or(fallback);
    let message = message.trim().to_owned();
    let code = format!("{NODE_NATIVE_RULE}/TS{raw_code}");
    let fingerprint = diagnostic_fingerprint(NativeFingerprintInput {
        domain: "node-native-diagnostic/v1",
        code: &code,
        message: &message,
        path: &path,
        range,
        files: source_files,
    });
    Some(NativeDiagnostic {
        code,
        severity: NativeSeverity::Error,
        source: NODE_NATIVE_PROVIDER_ID,
        message,
        help: None,
        location: NativeLocation {
            path: path.to_string(),
            range,
        },
        fingerprint,
    })
}

fn tsc_location(prefix: &str) -> (&str, Option<NativeRange>) {
    let Some(open) = prefix.rfind('(') else {
        return (prefix.trim(), None);
    };
    let Some(coordinates) = prefix
        .get(open + 1..)
        .and_then(|value| value.strip_suffix(')'))
    else {
        return (prefix.trim(), None);
    };
    let Some((line, character)) = coordinates.split_once(',') else {
        return (prefix.trim(), None);
    };
    let Some(line) = line
        .parse::<u32>()
        .ok()
        .and_then(|value| value.checked_sub(1))
    else {
        return (prefix.trim(), None);
    };
    let Some(character) = character
        .parse::<u32>()
        .ok()
        .and_then(|value| value.checked_sub(1))
    else {
        return (prefix.trim(), None);
    };
    let position = NativePosition {
        line,
        char: character,
    };
    (
        prefix.get(..open).unwrap_or(prefix).trim(),
        Some(NativeRange {
            start: position,
            end: position,
        }),
    )
}

fn outcome_exit_code(result: &NativeCheckResult) -> Option<i32> {
    result
        .evidence
        .get("exitCode")
        .and_then(serde_json::Value::as_i64)
        .and_then(|code| i32::try_from(code).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::asp::ProviderProfile;

    use super::super::test_support::NativeHarness;

    const PROJECT: &[(&str, &str)] = &[
        ("package.json", "{\"private\":true}\n"),
        ("package-lock.json", "{}\n"),
        ("tsconfig.json", "{}\n"),
        ("src/index.ts", "export const value: string = BROKEN;\n"),
    ];

    fn run_node(entries: &[(&str, &str)], tool_source: &str, cancelled: bool) -> NativeCheckResult {
        let harness = NativeHarness::new(
            ProviderProfile::NodeNative,
            entries,
            "npm",
            tool_source,
            cancelled,
        );
        evaluate(&harness.request())
    }

    #[test]
    fn parses_plain_tsc_diagnostics_with_zero_based_locations() {
        let path = RepoPath::from_protocol("src/index.ts").expect("fixture path");
        let files = BTreeMap::from([(
            path,
            Arc::<[u8]>::from(b"const value: string = 1;\n".as_slice()),
        )]);
        let diagnostic = parse_tsc_line(
            "src/index.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.",
            Path::new("/tmp/workspace"),
            &files,
            "tsconfig.json",
        )
        .expect("diagnostic");
        assert_eq!(diagnostic.location.path, "src/index.ts");
        assert_eq!(
            diagnostic.location.range.map(|range| range.start),
            Some(NativePosition { line: 0, char: 6 })
        );
        assert!(diagnostic.code.ends_with("/TS2322"));

        let config = RepoPath::from_protocol("tsconfig.json").expect("config path");
        let files = BTreeMap::from([(config, Arc::<[u8]>::from(b"{}\n".as_slice()))]);
        let diagnostic = parse_tsc_line(
            "error TS18003: No inputs were found in config file.",
            Path::new("/tmp/workspace"),
            &files,
            "tsconfig.json",
        )
        .expect("global diagnostic");
        assert_eq!(diagnostic.location.path, "tsconfig.json");
        assert!(diagnostic.location.range.is_none());
    }

    #[test]
    fn node_evaluator_runs_locked_install_typecheck_and_cleanup() {
        let result = run_node(
            PROJECT,
            r#"#!/bin/sh
mkdir -p node_modules/.bin
cat > node_modules/.bin/tsc <<'EOF'
#!/bin/sh
echo "src/index.ts(1,30): error TS2322: simulated type failure"
echo "error TS18003: simulated project failure"
echo "$PWD/src/index.ts"
exit 1
EOF
chmod 700 node_modules/.bin/tsc
exit 0
"#,
            false,
        );
        assert_eq!(result.status, NativeStatus::Findings);
        assert_eq!(result.diagnostics.len(), 2);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.location.path == "src/index.ts")
        );
        assert_eq!(result.evidence["dependencyTree"], "ephemeral");
        assert_eq!(result.evidence["compiler"], "node_modules/.bin/tsc");

        let clean = run_node(
            PROJECT,
            r#"#!/bin/sh
mkdir -p node_modules/.bin
cat > node_modules/.bin/tsc <<'EOF'
#!/bin/sh
echo "$PWD/src/index.ts"
exit 0
EOF
chmod 700 node_modules/.bin/tsc
exit 0
"#,
            false,
        );
        assert_eq!(clean.status, NativeStatus::Clean);
        assert!(clean.diagnostics.is_empty());
        assert!(clean.comparison_safe);
    }

    #[test]
    fn node_evaluator_preserves_install_and_preflight_failures() {
        let unavailable = run_node(
            PROJECT,
            "#!/bin/sh\necho 'npm error code ENOTCACHED' >&2\nexit 1\n",
            false,
        );
        assert_eq!(unavailable.status, NativeStatus::Unavailable);
        assert!(
            unavailable
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("offline cache"))
        );
        assert!(!unavailable.comparison_safe);

        let no_lock = run_node(
            &[
                ("package.json", "{}\n"),
                ("tsconfig.json", "{}\n"),
                ("src/index.ts", "export {};\n"),
            ],
            "#!/bin/sh\nexit 0\n",
            false,
        );
        assert_eq!(no_lock.status, NativeStatus::NotApplicable);
        assert!(no_lock.comparison_safe);

        let tracked_modules = run_node(
            &[
                ("package.json", "{}\n"),
                ("package-lock.json", "{}\n"),
                ("tsconfig.json", "{}\n"),
                ("node_modules/tracked.js", "export {};\n"),
            ],
            "#!/bin/sh\nexit 0\n",
            false,
        );
        assert_eq!(tracked_modules.status, NativeStatus::Incomplete);

        let cancelled = run_node(PROJECT, "#!/bin/sh\nexit 0\n", true);
        assert_eq!(cancelled.status, NativeStatus::Cancelled);
    }

    #[test]
    fn node_evaluator_bounds_project_enumeration() {
        let mut harness = NativeHarness::new(
            ProviderProfile::NodeNative,
            &[("package.json", "{}\n"), ("package-lock.json", "{}\n")],
            "npm",
            "#!/bin/sh\nexit 0\n",
            false,
        );
        for index in 0..=MAX_CONFIGS {
            let path = RepoPath::from_protocol(&format!("projects/{index}/tsconfig.json"))
                .expect("config path");
            harness.insert_virtual(path, b"{}\n");
        }
        let result = evaluate(&harness.request());
        assert_eq!(result.status, NativeStatus::Incomplete);
        assert!(
            result
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("project count"))
        );
    }

    #[test]
    fn node_evaluator_records_sources_outside_the_configured_projects() {
        let result = run_node(
            &[
                ("package.json", "{\"private\":true}\n"),
                ("package-lock.json", "{}\n"),
                ("tsconfig.build.json", "{}\n"),
                ("src/included.ts", "export {};\n"),
                ("src/orphan.ts", "export {};\n"),
            ],
            r#"#!/bin/sh
mkdir -p node_modules/.bin
cat > node_modules/.bin/tsc <<'EOF'
#!/bin/sh
echo "$PWD/src/included.ts"
exit 0
EOF
chmod 700 node_modules/.bin/tsc
exit 0
"#,
            false,
        );

        assert_eq!(result.status, NativeStatus::Clean);
        assert_eq!(result.evidence["selectedSourceFiles"], 2);
        assert_eq!(result.evidence["coveredSourceFiles"], 1);
        assert_eq!(result.evidence["unconfiguredTypeScriptSourceFiles"], 1);
        assert_eq!(result.evidence["configs"], json!(["tsconfig.build.json"]));
    }

    #[test]
    fn unconfigured_javascript_does_not_poison_typescript_coverage() {
        let result = run_node(
            &[
                ("package.json", "{\"private\":true}\n"),
                ("package-lock.json", "{}\n"),
                ("tsconfig.json", "{}\n"),
                ("src/included.ts", "export {};\n"),
                ("commitlint.config.js", "module.exports = {};\n"),
            ],
            r#"#!/bin/sh
mkdir -p node_modules/.bin
cat > node_modules/.bin/tsc <<'EOF'
#!/bin/sh
echo "$PWD/src/included.ts"
exit 0
EOF
chmod 700 node_modules/.bin/tsc
exit 0
"#,
            false,
        );

        assert_eq!(result.status, NativeStatus::Clean);
        assert_eq!(result.evidence["unconfiguredTypeScriptSourceFiles"], 0);
        assert_eq!(result.evidence["unconfiguredJavaScriptSourceFiles"], 1);
    }
}

use super::diagnostics::{error, warning};
use super::normalize_relative_path;
use crate::protocol::{GraphExtractionDiagnostic, GraphExtractionDiagnosticCategory};
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct TsConfig {
    base_url: String,
    paths: Vec<PathAlias>,
}

#[derive(Debug, Clone)]
struct PathAlias {
    pattern: String,
    targets: Vec<String>,
}

#[derive(Debug)]
pub struct TsConfigLoadResult {
    pub config: Option<TsConfig>,
    pub diagnostics: Vec<GraphExtractionDiagnostic>,
}

#[derive(Debug)]
pub struct ImportResolution {
    pub resolved_path: Option<String>,
    pub diagnostics: Vec<GraphExtractionDiagnostic>,
}

pub fn load_tsconfig(repo_root: &Path) -> TsConfigLoadResult {
    let path = repo_root.join("tsconfig.json");
    let contents = match read_tsconfig(&path) {
        TsConfigRead::Contents(contents) => contents,
        TsConfigRead::Missing(diagnostic) | TsConfigRead::ReadError(diagnostic) => {
            return TsConfigLoadResult {
                config: None,
                diagnostics: vec![diagnostic],
            }
        }
    };
    let value = match parse_tsconfig_json(&contents) {
        Ok(value) => value,
        Err(diagnostic) => {
            return TsConfigLoadResult {
                config: None,
                diagnostics: vec![diagnostic],
            }
        }
    };

    let mut diagnostics = Vec::new();
    let compiler_options = compiler_options(&value, &mut diagnostics);
    let base_url = base_url(compiler_options, &mut diagnostics);
    let mut paths = path_aliases(compiler_options, &mut diagnostics);
    paths.sort_by(|left, right| left.pattern.cmp(&right.pattern));

    if has_malformed_tsconfig(&diagnostics) {
        return TsConfigLoadResult {
            config: None,
            diagnostics,
        };
    }

    TsConfigLoadResult {
        config: Some(TsConfig { base_url, paths }),
        diagnostics,
    }
}

enum TsConfigRead {
    Missing(GraphExtractionDiagnostic),
    ReadError(GraphExtractionDiagnostic),
    Contents(String),
}

fn read_tsconfig(path: &Path) -> TsConfigRead {
    if !path.exists() {
        return TsConfigRead::Missing(warning(
            GraphExtractionDiagnosticCategory::MissingTsconfig,
            "tsconfig.json not found; path aliases disabled",
            Some("tsconfig.json".to_string()),
            None,
        ));
    }
    match std::fs::read_to_string(path) {
        Ok(contents) => TsConfigRead::Contents(contents),
        Err(error_value) => TsConfigRead::ReadError(error(
            GraphExtractionDiagnosticCategory::MalformedTsconfig,
            format!("failed to read tsconfig.json: {error_value}"),
            Some("tsconfig.json".to_string()),
            None,
        )),
    }
}

fn parse_tsconfig_json(contents: &str) -> Result<Value, GraphExtractionDiagnostic> {
    serde_json::from_str(contents).map_err(|error_value| {
        error(
            GraphExtractionDiagnosticCategory::MalformedTsconfig,
            format!("failed to parse tsconfig.json: {error_value}"),
            Some("tsconfig.json".to_string()),
            None,
        )
    })
}

fn compiler_options<'a>(
    value: &'a Value,
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
) -> Option<&'a Map<String, Value>> {
    match value.get("compilerOptions") {
        Some(Value::Object(options)) => Some(options),
        Some(_) => {
            diagnostics.push(error(
                GraphExtractionDiagnosticCategory::MalformedTsconfig,
                "compilerOptions must be an object",
                Some("tsconfig.json".to_string()),
                None,
            ));
            None
        }
        None => None,
    }
}

fn base_url(
    compiler_options: Option<&Map<String, Value>>,
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
) -> String {
    match compiler_options.and_then(|options| options.get("baseUrl")) {
        Some(Value::String(base_url)) => base_url.to_string(),
        Some(_) => {
            diagnostics.push(error(
                GraphExtractionDiagnosticCategory::MalformedTsconfig,
                "compilerOptions.baseUrl must be a string",
                Some("tsconfig.json".to_string()),
                None,
            ));
            ".".to_string()
        }
        None => ".".to_string(),
    }
}

fn path_aliases(
    compiler_options: Option<&Map<String, Value>>,
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
) -> Vec<PathAlias> {
    let Some(paths_value) = compiler_options.and_then(|options| options.get("paths")) else {
        return Vec::new();
    };
    match paths_value {
        Value::Object(path_entries) => path_entries
            .iter()
            .filter_map(|(pattern, targets)| parse_path_alias(pattern, targets, diagnostics))
            .collect(),
        _ => {
            diagnostics.push(error(
                GraphExtractionDiagnosticCategory::MalformedTsconfig,
                "compilerOptions.paths must be an object",
                Some("tsconfig.json".to_string()),
                None,
            ));
            Vec::new()
        }
    }
}

fn parse_path_alias(
    pattern: &str,
    targets_value: &Value,
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
) -> Option<PathAlias> {
    validate_pattern(pattern, diagnostics);
    let Value::Array(target_entries) = targets_value else {
        diagnostics.push(error(
            GraphExtractionDiagnosticCategory::MalformedTsconfig,
            format!("paths mapping {pattern} must be an array of string targets"),
            Some("tsconfig.json".to_string()),
            None,
        ));
        return None;
    };
    if target_entries.is_empty() {
        diagnostics.push(error(
            GraphExtractionDiagnosticCategory::MalformedTsconfig,
            format!("paths mapping {pattern} must contain at least one target"),
            Some("tsconfig.json".to_string()),
            None,
        ));
        return None;
    }
    Some(PathAlias {
        pattern: pattern.to_string(),
        targets: parse_alias_targets(pattern, target_entries, diagnostics),
    })
}

fn validate_pattern(pattern: &str, diagnostics: &mut Vec<GraphExtractionDiagnostic>) {
    if pattern.matches('*').count() > 1 {
        diagnostics.push(error(
            GraphExtractionDiagnosticCategory::MalformedTsconfig,
            format!("paths pattern {pattern} must contain at most one wildcard"),
            Some("tsconfig.json".to_string()),
            None,
        ));
    }
}

fn parse_alias_targets(
    pattern: &str,
    target_entries: &[Value],
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
) -> Vec<String> {
    target_entries
        .iter()
        .filter_map(|target| {
            let target = target.as_str().map(str::to_string);
            validate_target(pattern, target.as_deref(), diagnostics);
            target
        })
        .collect()
}

fn validate_target(
    pattern: &str,
    target: Option<&str>,
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
) {
    let Some(target) = target else {
        diagnostics.push(error(
            GraphExtractionDiagnosticCategory::MalformedTsconfig,
            format!("paths mapping {pattern} targets must be strings"),
            Some("tsconfig.json".to_string()),
            None,
        ));
        return;
    };
    if target.matches('*').count() > 1 {
        diagnostics.push(error(
            GraphExtractionDiagnosticCategory::MalformedTsconfig,
            format!("paths mapping {pattern} target {target} must contain at most one wildcard"),
            Some("tsconfig.json".to_string()),
            None,
        ));
    }
    if !pattern.contains('*') && target.contains('*') {
        diagnostics.push(error(
            GraphExtractionDiagnosticCategory::MalformedTsconfig,
            format!(
                "paths mapping {pattern} target {target} cannot contain a wildcard without a wildcard pattern"
            ),
            Some("tsconfig.json".to_string()),
            None,
        ));
    }
}

fn has_malformed_tsconfig(diagnostics: &[GraphExtractionDiagnostic]) -> bool {
    diagnostics.iter().any(|diagnostic| {
        diagnostic.category == GraphExtractionDiagnosticCategory::MalformedTsconfig
    })
}

pub fn resolve_import(
    specifier: &str,
    from_path: &str,
    known_files: &BTreeSet<String>,
    tsconfig: Option<&TsConfig>,
) -> ImportResolution {
    if specifier.starts_with('.') {
        let base_dir = Path::new(from_path)
            .parent()
            .unwrap_or_else(|| Path::new(""));
        return resolve_candidate(base_dir.join(specifier), known_files, specifier, from_path);
    }

    if let Some(config) = tsconfig {
        for alias in &config.paths {
            if let Some(capture) = match_alias(&alias.pattern, specifier) {
                for target in &alias.targets {
                    let target = if let Some(capture) = capture.as_deref() {
                        target.replacen('*', capture, 1)
                    } else {
                        target.clone()
                    };
                    let candidate = PathBuf::from(&config.base_url).join(target);
                    let resolution =
                        resolve_candidate(candidate, known_files, specifier, from_path);
                    if resolution.resolved_path.is_some() || !resolution.diagnostics.is_empty() {
                        return resolution;
                    }
                }
            }
        }
    }

    ImportResolution {
        resolved_path: None,
        diagnostics: Vec::new(),
    }
}

fn match_alias(pattern: &str, specifier: &str) -> Option<Option<String>> {
    let wildcard_count = pattern.matches('*').count();
    if wildcard_count == 0 {
        return (pattern == specifier).then_some(None);
    }
    if wildcard_count != 1 {
        return None;
    }
    let (prefix, suffix) = pattern.split_once('*')?;
    if !specifier.starts_with(prefix) || !specifier.ends_with(suffix) {
        return None;
    }
    let capture = &specifier[prefix.len()..specifier.len() - suffix.len()];
    Some(Some(capture.to_string()))
}

fn resolve_candidate(
    candidate: PathBuf,
    known_files: &BTreeSet<String>,
    specifier: &str,
    from_path: &str,
) -> ImportResolution {
    let normalized = match normalize_relative_path(&candidate) {
        Ok(path) => path,
        Err(()) => {
            return ImportResolution {
                resolved_path: None,
                diagnostics: vec![error(
                    GraphExtractionDiagnosticCategory::PathTraversal,
                    format!("import {specifier} from {from_path} escapes the repository"),
                    Some(from_path.to_string()),
                    None,
                )],
            }
        }
    };

    for candidate in resolution_candidates(&normalized) {
        if known_files.contains(&candidate) {
            return ImportResolution {
                resolved_path: Some(candidate),
                diagnostics: Vec::new(),
            };
        }
    }

    ImportResolution {
        resolved_path: None,
        diagnostics: Vec::new(),
    }
}

fn resolution_candidates(path: &str) -> Vec<String> {
    let mut candidates = vec![path.to_string()];
    if Path::new(path).extension().is_none() {
        for extension in [".ts", ".tsx", ".js", ".jsx"] {
            candidates.push(format!("{path}{extension}"));
        }
        for extension in ["ts", "tsx", "js", "jsx"] {
            candidates.push(format!("{path}/index.{extension}"));
        }
    }
    candidates
}

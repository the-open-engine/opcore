use super::diagnostics::{error, warning};
use super::normalize_relative_path;
use super::tsconfig::ImportResolution;
use crate::protocol::GraphExtractionDiagnosticCategory;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub fn resolve_import(
    specifier: &str,
    from_path: &str,
    known_files: &BTreeSet<String>,
) -> ImportResolution {
    if specifier.starts_with('.') {
        return resolve_relative_import(specifier, from_path, known_files);
    }
    resolve_absolute_import(specifier, from_path, known_files)
}

fn resolve_relative_import(
    specifier: &str,
    from_path: &str,
    known_files: &BTreeSet<String>,
) -> ImportResolution {
    let dot_count = specifier
        .chars()
        .take_while(|character| *character == '.')
        .count();
    let module = specifier
        .get(dot_count..)
        .unwrap_or_default()
        .trim_matches('.');
    let mut base = Path::new(from_path)
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .to_path_buf();
    for _ in 1..dot_count {
        if !base.pop() {
            return ImportResolution {
                resolved_path: None,
                diagnostics: vec![error(
                    GraphExtractionDiagnosticCategory::PathTraversal,
                    format!("relative Python import {specifier} from {from_path} escapes the repository"),
                    Some(from_path.to_string()),
                    Some("python".to_string()),
                )],
            };
        }
    }
    if !module.is_empty() {
        base = base.join(module.replace('.', "/"));
    }
    match resolve_path_candidate(base, known_files) {
        Ok(Some(path)) => ImportResolution {
            resolved_path: Some(path),
            diagnostics: Vec::new(),
        },
        Ok(None) => unresolved_import(specifier, from_path),
        Err(()) => ImportResolution {
            resolved_path: None,
            diagnostics: vec![error(
                GraphExtractionDiagnosticCategory::PathTraversal,
                format!(
                    "relative Python import {specifier} from {from_path} escapes the repository"
                ),
                Some(from_path.to_string()),
                Some("python".to_string()),
            )],
        },
    }
}

fn resolve_absolute_import(
    specifier: &str,
    from_path: &str,
    known_files: &BTreeSet<String>,
) -> ImportResolution {
    let module_path = specifier.replace('.', "/");
    if let Some(path) = resolve_module_suffix(&module_path, known_files) {
        return ImportResolution {
            resolved_path: Some(path),
            diagnostics: Vec::new(),
        };
    }
    if is_repo_local_prefix(specifier, known_files) {
        return unresolved_import(specifier, from_path);
    }
    ImportResolution {
        resolved_path: None,
        diagnostics: Vec::new(),
    }
}

fn resolve_path_candidate(
    candidate: PathBuf,
    known_files: &BTreeSet<String>,
) -> Result<Option<String>, ()> {
    let normalized = normalize_relative_path(&candidate)?;
    Ok(resolve_module_suffix(&normalized, known_files))
}

fn resolve_module_suffix(module_path: &str, known_files: &BTreeSet<String>) -> Option<String> {
    for candidate in resolution_candidates(module_path) {
        if known_files.contains(&candidate) {
            return Some(candidate);
        }
        let suffix = format!("/{candidate}");
        let mut matches = known_files
            .iter()
            .filter(|path| path.ends_with(&suffix))
            .cloned()
            .collect::<Vec<_>>();
        matches.sort();
        if matches.len() == 1 {
            return matches.into_iter().next();
        }
    }
    None
}

fn resolution_candidates(path: &str) -> Vec<String> {
    let mut candidates = vec![path.to_string()];
    if Path::new(path).extension().is_none() {
        candidates.extend([
            format!("{path}.py"),
            format!("{path}.pyi"),
            format!("{path}/__init__.py"),
            format!("{path}/__init__.pyi"),
        ]);
    }
    candidates
}

fn is_repo_local_prefix(specifier: &str, known_files: &BTreeSet<String>) -> bool {
    let Some(prefix) = specifier
        .split('.')
        .next()
        .filter(|prefix| !prefix.is_empty())
    else {
        return false;
    };
    known_files
        .iter()
        .filter(|path| is_python_source_path(path))
        .flat_map(|path| module_prefixes(path))
        .any(|known_prefix| known_prefix == prefix)
}

fn module_prefixes(path: &str) -> Vec<String> {
    let mut parts = path
        .trim_end_matches(".py")
        .trim_end_matches(".pyi")
        .split('/')
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if parts.last().is_some_and(|part| part == "__init__") {
        parts.pop();
    }
    let mut prefixes = Vec::new();
    if let Some(first) = parts.first() {
        prefixes.push(first.clone());
    }
    if let Some(second) = parts.get(1) {
        if parts
            .first()
            .is_some_and(|first| is_common_source_root(first))
        {
            prefixes.push(second.clone());
        }
    }
    prefixes
}

fn is_common_source_root(path: &str) -> bool {
    matches!(path, "src" | "lib" | "app" | "packages")
}

fn unresolved_import(specifier: &str, from_path: &str) -> ImportResolution {
    ImportResolution {
        resolved_path: None,
        diagnostics: vec![warning(
            GraphExtractionDiagnosticCategory::UnresolvedImport,
            format!("unresolved Python import {specifier}"),
            (!from_path.is_empty()).then(|| from_path.to_string()),
            Some("python".to_string()),
        )],
    }
}

fn is_python_source_path(path: &str) -> bool {
    path.ends_with(".py") || path.ends_with(".pyi")
}

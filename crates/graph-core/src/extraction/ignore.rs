use super::diagnostics::error;
use crate::protocol::{GraphExtractionDiagnostic, GraphExtractionDiagnosticCategory};
use globset::{Glob, GlobSet, GlobSetBuilder};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub(super) struct IgnoreMatcher {
    built_in: GlobSet,
    rules: Vec<IgnoreRule>,
}

#[derive(Clone)]
struct IgnoreRule {
    patterns: GlobSet,
    negated: bool,
}

impl IgnoreMatcher {
    pub(super) fn is_ignored(&self, relative_path: &str, is_dir: bool) -> bool {
        let candidate = if is_dir {
            format!("{relative_path}/")
        } else {
            relative_path.to_string()
        };
        if self.built_in.is_match(&candidate) {
            return true;
        }
        let mut ignored = false;
        for rule in &self.rules {
            if rule.patterns.is_match(&candidate) {
                ignored = !rule.negated;
            }
        }
        ignored
    }
}

const BUILT_IN_IGNORE_GLOBS: &[&str] = &[
    "**/.git/**",
    "node_modules/**",
    "**/node_modules/**",
    ".pnpm/**",
    "**/.pnpm/**",
    "vendor/**",
    "**/vendor/**",
    "**/dist/**",
    "**/target/**",
    "**/.ace/**",
    "**/.agents/**",
    "**/.claude/**",
    "**/.codex/**",
    "**/.gemini/**",
    "**/.lattice/**",
    "**/.opencode/**",
    "**/.opcore/**",
    "**/.rox-cache/**",
    ".robustness-engine-cache/**",
    "**/.robustness-engine-cache/**",
    ".venv/**",
    "**/.venv/**",
    "venv/**",
    "**/venv/**",
    "env/**",
    "**/env/**",
    "__pycache__/**",
    "**/__pycache__/**",
    ".eggs/**",
    "**/.eggs/**",
    "build/**",
    "**/build/**",
    ".tox/**",
    "**/.tox/**",
    ".mypy_cache/**",
    "**/.mypy_cache/**",
    ".pytest_cache/**",
    "**/.pytest_cache/**",
    ".ruff_cache/**",
    "**/.ruff_cache/**",
    "site-packages/**",
    "**/site-packages/**",
    "*.egg-info/",
    "*.egg-info/**",
    "**/*.egg-info/",
    "**/*.egg-info/**",
    "*.dist-info/",
    "*.dist-info/**",
    "**/*.dist-info/",
    "**/*.dist-info/**",
    "dist/**",
    "target/**",
];

pub(super) fn ignore_matcher(repo_root: &Path) -> Result<IgnoreMatcher, GraphExtractionDiagnostic> {
    let mut builder = GlobSetBuilder::new();
    for pattern in BUILT_IN_IGNORE_GLOBS {
        let glob = Glob::new(pattern).map_err(|source| {
            error(
                GraphExtractionDiagnosticCategory::IoError,
                format!("invalid built-in ignore glob {pattern}: {source}"),
                None,
                None,
            )
        })?;
        builder.add(glob);
    }
    let mut rules = Vec::new();
    add_ignore_file(&mut rules, repo_root.join(".gitignore"));
    add_ignore_file(&mut rules, repo_root.join(".code-review-graphignore"));
    Ok(IgnoreMatcher {
        built_in: builder.build().map_err(|source| {
            error(
                GraphExtractionDiagnosticCategory::IoError,
                format!("invalid built-in ignore set: {source}"),
                None,
                None,
            )
        })?,
        rules,
    })
}

fn add_ignore_file(rules: &mut Vec<IgnoreRule>, path: PathBuf) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    for raw_line in content.lines() {
        let Some(line) = parse_ignore_line(raw_line) else {
            continue;
        };
        let mut builder = GlobSetBuilder::new();
        for pattern in ignore_patterns(&line.normalized) {
            if let Ok(glob) = Glob::new(&pattern) {
                builder.add(glob);
            }
        }
        if let Ok(patterns) = builder.build() {
            rules.push(IgnoreRule {
                patterns,
                negated: line.negated,
            });
        }
    }
}

struct ParsedIgnoreLine {
    normalized: String,
    negated: bool,
}

fn parse_ignore_line(raw_line: &str) -> Option<ParsedIgnoreLine> {
    let mut line = raw_line.trim();
    if line.is_empty() {
        return None;
    }
    if let Some(rest) = line.strip_prefix("\\#") {
        line = rest;
    } else if line.starts_with('#') {
        return None;
    }
    let negated = parse_ignore_negation(&mut line);
    if line.is_empty() {
        return None;
    }
    Some(ParsedIgnoreLine {
        normalized: line.trim_start_matches('/').replace('\\', "/"),
        negated,
    })
}

fn parse_ignore_negation(line: &mut &str) -> bool {
    if let Some(rest) = line.strip_prefix("\\!") {
        *line = rest;
        false
    } else if let Some(rest) = line.strip_prefix('!') {
        *line = rest.trim();
        true
    } else {
        false
    }
}

fn ignore_patterns(normalized: &str) -> Vec<String> {
    if normalized.ends_with('/') {
        return directory_ignore_patterns(normalized.trim_end_matches('/'));
    }
    if normalized.contains('/') {
        return vec![normalized.to_string(), format!("{normalized}/**")];
    }
    vec![
        normalized.to_string(),
        format!("**/{normalized}"),
        format!("**/{normalized}/**"),
    ]
}

fn directory_ignore_patterns(directory: &str) -> Vec<String> {
    vec![
        format!("{directory}/"),
        format!("**/{directory}/"),
        format!("{directory}/**"),
        format!("**/{directory}/**"),
    ]
}

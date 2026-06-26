use super::diagnostics::{error, warning};
use super::language::SourceLanguage;
use super::ExtractionOptions;
use crate::protocol::{GraphExtractionDiagnostic, GraphExtractionDiagnosticCategory};
use globset::{Glob, GlobSet, GlobSetBuilder};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use walkdir::{DirEntry, WalkDir};

#[derive(Debug, Clone)]
pub struct DiscoveredSource {
    pub absolute_path: PathBuf,
    pub relative_path: String,
    pub language: SourceLanguage,
    pub sha256: String,
}

#[derive(Debug)]
pub struct DiscoveryResult {
    pub repo_root: PathBuf,
    pub repo_root_display: String,
    pub sources: Vec<DiscoveredSource>,
    pub diagnostics: Vec<GraphExtractionDiagnostic>,
}

pub fn discover_sources(options: &ExtractionOptions) -> DiscoveryResult {
    let mut diagnostics = Vec::new();
    let repo_root = canonical_repo_root(options, &mut diagnostics);
    let repo_root_display = repo_root.to_string_lossy().replace('\\', "/");
    if has_io_error(&diagnostics) {
        return DiscoveryResult {
            repo_root,
            repo_root_display,
            sources: Vec::new(),
            diagnostics,
        };
    }

    let mut discovery = match SourceDiscovery::new(options) {
        Ok(discovery) => discovery,
        Err(diagnostic) => {
            diagnostics.push(diagnostic);
            return DiscoveryResult {
                repo_root,
                repo_root_display,
                sources: Vec::new(),
                diagnostics,
            };
        }
    };
    discovery.walk(&repo_root);
    discovery
        .sources
        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

    DiscoveryResult {
        repo_root,
        repo_root_display,
        sources: discovery.sources,
        diagnostics: discovery.diagnostics,
    }
}

struct SourceDiscovery<'a> {
    options: &'a ExtractionOptions,
    ignore_matcher: IgnoreMatcher,
    effective_watch_paths: Vec<String>,
    sources: Vec<DiscoveredSource>,
    diagnostics: Vec<GraphExtractionDiagnostic>,
    depth_reported: bool,
}

impl<'a> SourceDiscovery<'a> {
    fn new(options: &'a ExtractionOptions) -> Result<Self, GraphExtractionDiagnostic> {
        let repo_root = options.repo_root.as_path();
        let effective_watch_paths =
            normalize_watch_paths(&options.watch_paths).map_err(|message| {
                error(
                    GraphExtractionDiagnosticCategory::PathTraversal,
                    message,
                    None,
                    None,
                )
            })?;
        Ok(Self {
            options,
            ignore_matcher: ignore_matcher(repo_root)?,
            effective_watch_paths,
            sources: Vec::new(),
            diagnostics: Vec::new(),
            depth_reported: false,
        })
    }

    fn walk(&mut self, repo_root: &Path) {
        let ignore_matcher = self.ignore_matcher.clone();
        for entry in WalkDir::new(repo_root)
            .follow_links(false)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(|entry| !ignored_directory(repo_root, entry, &ignore_matcher))
        {
            self.handle_entry(repo_root, entry);
        }
    }

    fn handle_entry(&mut self, repo_root: &Path, entry: walkdir::Result<DirEntry>) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error_value) => return self.report_entry_error(error_value),
        };
        let Some(relative_path) = self.relative_path_for_entry(repo_root, &entry) else {
            return;
        };
        if let Some(language) = SourceLanguage::from_path(entry.path()) {
            self.push_source(&entry, relative_path, language);
        } else if let Some(extension) = SourceLanguage::unsupported_source_extension(entry.path()) {
            self.report_unsupported(extension, relative_path);
        }
    }

    fn relative_path_for_entry(&mut self, repo_root: &Path, entry: &DirEntry) -> Option<String> {
        if !entry.file_type().is_file() {
            return None;
        }
        let Ok(relative_path) = repo_relative_path(repo_root, entry.path()) else {
            self.diagnostics.push(error(
                GraphExtractionDiagnosticCategory::PathTraversal,
                "discovered file escaped repo root",
                None,
                None,
            ));
            return None;
        };
        if self.ignore_matcher.is_ignored(&relative_path, false) {
            return None;
        }
        if !watch_path_included(&relative_path, &self.effective_watch_paths) {
            return None;
        }
        self.check_depth(relative_path)
    }

    fn check_depth(&mut self, relative_path: String) -> Option<String> {
        let depth = Path::new(&relative_path).components().count();
        if depth <= self.options.max_depth {
            return Some(relative_path);
        }
        if !self.depth_reported {
            self.diagnostics.push(error(
                GraphExtractionDiagnosticCategory::MaxDepthExceeded,
                format!(
                    "source discovery exceeded maxDepth {} at {relative_path}",
                    self.options.max_depth
                ),
                Some(relative_path.clone()),
                None,
            ));
            self.depth_reported = true;
        }
        None
    }

    fn push_source(&mut self, entry: &DirEntry, relative_path: String, language: SourceLanguage) {
        if self.sources.len() >= self.options.max_files {
            self.diagnostics.push(error(
                GraphExtractionDiagnosticCategory::MaxFilesExceeded,
                format!(
                    "source discovery exceeded maxFiles {}",
                    self.options.max_files
                ),
                Some(relative_path),
                Some(language.as_str().to_string()),
            ));
            return;
        }
        match std::fs::read(entry.path()) {
            Ok(bytes) => self.sources.push(DiscoveredSource {
                absolute_path: entry.path().to_path_buf(),
                relative_path,
                language,
                sha256: sha256_hex(&bytes),
            }),
            Err(error_value) => self.diagnostics.push(error(
                GraphExtractionDiagnosticCategory::IoError,
                format!("failed to hash source file: {error_value}"),
                Some(relative_path),
                Some(language.as_str().to_string()),
            )),
        }
    }

    fn report_entry_error(&mut self, error_value: walkdir::Error) {
        self.diagnostics.push(error(
            GraphExtractionDiagnosticCategory::IoError,
            format!("failed to read repository entry: {error_value}"),
            None,
            None,
        ));
    }

    fn report_unsupported(&mut self, extension: String, relative_path: String) {
        self.diagnostics.push(warning(
            GraphExtractionDiagnosticCategory::UnsupportedLanguage,
            format!("unsupported source language extension .{extension}"),
            Some(relative_path),
            Some(extension),
        ));
    }
}

fn canonical_repo_root(
    options: &ExtractionOptions,
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
) -> PathBuf {
    match options.repo_root.canonicalize() {
        Ok(root) => root,
        Err(error_value) => {
            diagnostics.push(error(
                GraphExtractionDiagnosticCategory::IoError,
                format!("failed to canonicalize repo root: {error_value}"),
                None,
                None,
            ));
            options.repo_root.clone()
        }
    }
}

fn has_io_error(diagnostics: &[GraphExtractionDiagnostic]) -> bool {
    diagnostics
        .iter()
        .any(|diagnostic| diagnostic.category == GraphExtractionDiagnosticCategory::IoError)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn repo_relative_path(repo_root: &Path, path: &Path) -> Result<String, ()> {
    let relative = path.strip_prefix(repo_root).map_err(|_| ())?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

#[derive(Clone)]
struct IgnoreMatcher {
    built_in: GlobSet,
    rules: Vec<IgnoreRule>,
}

#[derive(Clone)]
struct IgnoreRule {
    patterns: GlobSet,
    negated: bool,
}

impl IgnoreMatcher {
    fn is_ignored(&self, relative_path: &str, is_dir: bool) -> bool {
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

fn ignored_directory(repo_root: &Path, entry: &DirEntry, ignore_matcher: &IgnoreMatcher) -> bool {
    if !entry.file_type().is_dir() {
        return false;
    }
    let Ok(relative_path) = repo_relative_path(repo_root, entry.path()) else {
        return false;
    };
    !relative_path.is_empty() && ignore_matcher.is_ignored(&relative_path, true)
}

fn ignore_matcher(repo_root: &Path) -> Result<IgnoreMatcher, GraphExtractionDiagnostic> {
    let mut builder = GlobSetBuilder::new();
    for pattern in [
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
        "**/.lattice/**",
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
    ] {
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

fn split_watch_paths(value: &str) -> Vec<String> {
    value
        .split([',', ':'])
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

pub fn normalize_watch_paths(paths: &[String]) -> Result<Vec<String>, String> {
    let mut normalized_paths = Vec::new();
    for raw_path in paths.iter().flat_map(|path| split_watch_paths(path)) {
        let normalized = normalize_watch_path(&raw_path)?;
        if !normalized_paths.contains(&normalized) {
            normalized_paths.push(normalized);
        }
    }
    Ok(normalized_paths)
}

fn normalize_watch_path(path: &str) -> Result<String, String> {
    normalize_repo_relative_path(path, "watch path")
}

pub fn normalize_repo_relative_path(path: &str, label: &str) -> Result<String, String> {
    let path = path.trim();
    if path.contains('\0') {
        return Err(format!("{label} must not contain null bytes: {path:?}"));
    }
    if is_absolute_repo_relative_path(path) {
        return Err(format!("{label} must be repo-relative: {path}"));
    }
    let slash_path = path.replace('\\', "/");
    let mut components = Vec::new();
    for component in slash_path.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                return Err(format!("{label} must not escape the repository: {path}"));
            }
            component => components.push(component),
        }
    }
    if components.is_empty() {
        return Err(format!(
            "{label} must name a repo-relative file or directory: {path}"
        ));
    }
    Ok(components.join("/"))
}

fn is_absolute_repo_relative_path(value: &str) -> bool {
    value.starts_with('/') || value.starts_with('\\') || is_windows_absolute_path(value)
}

fn is_windows_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    matches!(
        (bytes.first(), bytes.get(1), bytes.get(2)),
        (Some(drive), Some(b':'), Some(b'/' | b'\\')) if drive.is_ascii_alphabetic()
    )
}

fn watch_path_included(relative_path: &str, watch_paths: &[String]) -> bool {
    watch_paths.is_empty()
        || watch_paths.iter().any(|watch_path| {
            relative_path == watch_path || relative_path.starts_with(&format!("{watch_path}/"))
        })
}

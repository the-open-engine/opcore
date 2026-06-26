use super::super::diagnostics::error;
use crate::protocol::{GraphExtractionDiagnostic, GraphExtractionDiagnosticCategory};
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::io::{self, ErrorKind};
use std::path::{Component, Path};
use toml::Value;

#[derive(Debug, Clone, Default)]
pub struct RustManifest {
    dependencies: BTreeSet<String>,
    packages: Vec<RustPackage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RustPackage {
    root: String,
    dependencies: BTreeSet<String>,
}

impl RustManifest {
    pub fn load(repo_root: &Path) -> Result<Self, GraphExtractionDiagnostic> {
        let Some(parsed) = read_manifest(repo_root, &repo_root.join("Cargo.toml"))? else {
            return Ok(Self::default());
        };

        let mut packages = Vec::new();
        if parsed.get("package").and_then(Value::as_table).is_some() {
            packages.push(RustPackage {
                root: String::new(),
                dependencies: collect_dependency_tables(&parsed),
            });
        };

        for member in workspace_members(repo_root, &parsed)? {
            let Some(member_manifest) =
                read_manifest(repo_root, &repo_root.join(&member).join("Cargo.toml"))?
            else {
                continue;
            };
            packages.push(RustPackage {
                root: member,
                dependencies: collect_dependency_tables(&member_manifest),
            });
        }

        packages.sort_by(|left, right| {
            right
                .root
                .len()
                .cmp(&left.root.len())
                .then_with(|| left.root.cmp(&right.root))
        });
        Ok(Self {
            dependencies: collect_dependency_tables(&parsed),
            packages,
        })
    }

    pub fn dependency_for_path_segment(&self, path: &str, segment: &str) -> Option<String> {
        self.package_for_path(path)
            .and_then(|package| dependency_for_segment(&package.dependencies, segment))
            .or_else(|| dependency_for_segment(&self.dependencies, segment))
    }

    pub fn module_path_for_file(&self, path: &str) -> String {
        let source_relative = self
            .package_for_path(path)
            .and_then(|package| package.source_relative_path(path))
            .unwrap_or_else(|| source_relative_path(path));
        module_path_from_source_relative(&source_relative)
    }

    pub fn package_root_for_path(&self, path: &str) -> String {
        self.package_for_path(path)
            .map(|package| package.root.clone())
            .unwrap_or_default()
    }

    fn package_for_path(&self, path: &str) -> Option<&RustPackage> {
        self.packages
            .iter()
            .find(|package| package.source_relative_path(path).is_some())
    }
}

impl RustPackage {
    fn source_relative_path(&self, path: &str) -> Option<String> {
        if self.root.is_empty() {
            return path.strip_prefix("src/").map(ToString::to_string);
        }
        let prefix = format!("{}/src/", self.root);
        path.strip_prefix(&prefix).map(ToString::to_string)
    }
}

fn read_manifest(
    repo_root: &Path,
    path: &Path,
) -> Result<Option<Value>, GraphExtractionDiagnostic> {
    let source = match std::fs::read_to_string(path) {
        Ok(source) => source,
        Err(read_error) if read_error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(read_error) => {
            return Err(manifest_diagnostic(
                repo_root,
                path,
                GraphExtractionDiagnosticCategory::IoError,
                format!("failed to read Cargo manifest: {read_error}"),
            ));
        }
    };
    source.parse::<Value>().map(Some).map_err(|parse_error| {
        manifest_diagnostic(
            repo_root,
            path,
            GraphExtractionDiagnosticCategory::ParseError,
            format!("failed to parse Cargo manifest: {parse_error}"),
        )
    })
}

fn manifest_diagnostic(
    repo_root: &Path,
    path: &Path,
    category: GraphExtractionDiagnosticCategory,
    message: String,
) -> GraphExtractionDiagnostic {
    error(
        category,
        message,
        Some(repo_relative_path(repo_root, path)),
        Some("rust".to_string()),
    )
}

fn collect_dependency_tables(root: &Value) -> BTreeSet<String> {
    let mut dependencies = BTreeSet::new();
    collect_table_keys(root, "dependencies", &mut dependencies);
    collect_table_keys(root, "dev-dependencies", &mut dependencies);
    collect_table_keys(root, "build-dependencies", &mut dependencies);
    dependencies
}

fn collect_table_keys(root: &Value, key: &str, dependencies: &mut BTreeSet<String>) {
    let Some(table) = root.get(key).and_then(Value::as_table) else {
        return;
    };
    for dependency in table.keys() {
        dependencies.insert(dependency.clone());
        dependencies.insert(dependency.replace('-', "_"));
    }
}

fn dependency_for_segment(dependencies: &BTreeSet<String>, segment: &str) -> Option<String> {
    dependencies
        .contains(segment)
        .then(|| segment.to_string())
        .or_else(|| {
            dependencies
                .iter()
                .find(|dependency| dependency.replace('-', "_") == segment)
                .cloned()
        })
}

fn workspace_members(
    repo_root: &Path,
    manifest: &Value,
) -> Result<Vec<String>, GraphExtractionDiagnostic> {
    let mut members = BTreeSet::new();
    let Some(entries) = manifest
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(Value::as_array)
    else {
        return Ok(Vec::new());
    };

    for entry in entries {
        let Some(pattern) = entry.as_str() else {
            continue;
        };
        for member in expand_workspace_member(repo_root, pattern)? {
            members.insert(member);
        }
    }
    Ok(members.into_iter().collect())
}

fn expand_workspace_member(
    repo_root: &Path,
    pattern: &str,
) -> Result<Vec<String>, GraphExtractionDiagnostic> {
    if pattern.contains('*') {
        return expand_workspace_member_glob(repo_root, pattern);
    }
    Ok(normalize_member_path(pattern).into_iter().collect())
}

fn expand_workspace_member_glob(
    repo_root: &Path,
    pattern: &str,
) -> Result<Vec<String>, GraphExtractionDiagnostic> {
    let Some(prefix) = pattern.strip_suffix("/*") else {
        return Ok(Vec::new());
    };
    let Some(prefix) = normalize_member_path(prefix) else {
        return Ok(Vec::new());
    };
    let directory = repo_root.join(&prefix);
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(read_error) if read_error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(read_error) => {
            return Err(manifest_diagnostic(
                repo_root,
                &directory,
                GraphExtractionDiagnosticCategory::IoError,
                format!("failed to read Cargo workspace member directory: {read_error}"),
            ));
        }
    };
    let mut members = Vec::new();
    for entry in entries {
        let entry = workspace_member_entry(repo_root, &directory, entry)?;
        if let Some(member) = workspace_member_from_entry(repo_root, &prefix, entry)? {
            members.push(member);
        }
    }
    Ok(members)
}

fn workspace_member_entry(
    repo_root: &Path,
    directory: &Path,
    entry: Result<std::fs::DirEntry, io::Error>,
) -> Result<std::fs::DirEntry, GraphExtractionDiagnostic> {
    entry.map_err(|read_error| {
        manifest_diagnostic(
            repo_root,
            directory,
            GraphExtractionDiagnosticCategory::IoError,
            format!("failed to read Cargo workspace member entry: {read_error}"),
        )
    })
}

fn workspace_member_from_entry(
    repo_root: &Path,
    prefix: &str,
    entry: std::fs::DirEntry,
) -> Result<Option<String>, GraphExtractionDiagnostic> {
    workspace_member_from_entry_parts(
        repo_root,
        prefix,
        &entry.path(),
        entry.file_name(),
        entry.file_type(),
    )
}

fn workspace_member_from_entry_parts(
    repo_root: &Path,
    prefix: &str,
    path: &Path,
    file_name: OsString,
    file_type: Result<std::fs::FileType, io::Error>,
) -> Result<Option<String>, GraphExtractionDiagnostic> {
    let file_type = file_type.map_err(|file_type_error| {
        manifest_diagnostic(
            repo_root,
            path,
            GraphExtractionDiagnosticCategory::IoError,
            format!("failed to inspect Cargo workspace member entry: {file_type_error}"),
        )
    })?;
    if !file_type.is_dir() {
        return Ok(None);
    }
    let Some(name) = file_name.to_str().map(ToString::to_string) else {
        return Ok(None);
    };
    Ok(Some(format!("{prefix}/{name}")))
}

fn normalize_member_path(path: &str) -> Option<String> {
    let mut components = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(value) => components.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!components.is_empty()).then(|| components.join("/"))
}

fn source_relative_path(path: &str) -> String {
    path.strip_prefix("src/")
        .map(ToString::to_string)
        .unwrap_or_else(|| path.to_string())
}

fn module_path_from_source_relative(path: &str) -> String {
    let mut parts = Vec::new();
    for segment in path.split('/') {
        let name = segment.strip_suffix(".rs").unwrap_or(segment);
        if name == "lib" || name == "main" || name == "mod" {
            continue;
        }
        if !name.is_empty() {
            parts.push(name.to_string());
        }
    }
    if parts.is_empty() {
        "crate".to_string()
    } else {
        format!("crate::{}", parts.join("::"))
    }
}

fn repo_relative_path(repo_root: &Path, path: &Path) -> String {
    path.strip_prefix(repo_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::ErrorKind;
    use std::path::PathBuf;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn rust_manifest_workspace_glob_entry_errors_are_typed_io_diagnostics() -> TestResult {
        let repo_root = PathBuf::from("/repo");
        let directory = repo_root.join("crates");
        let diagnostic = workspace_member_entry(
            &repo_root,
            &directory,
            Err(io::Error::new(ErrorKind::PermissionDenied, "entry denied")),
        )
        .err()
        .ok_or_else(|| io::Error::other("expected workspace entry diagnostic"))?;

        assert_eq!(
            diagnostic.category,
            GraphExtractionDiagnosticCategory::IoError
        );
        assert_eq!(diagnostic.path.as_deref(), Some("crates"));
        assert_eq!(diagnostic.language.as_deref(), Some("rust"));
        assert!(diagnostic
            .message
            .contains("failed to read Cargo workspace member entry"));
        Ok(())
    }

    #[test]
    fn rust_manifest_workspace_glob_metadata_errors_are_typed_io_diagnostics() -> TestResult {
        let repo_root = PathBuf::from("/repo");
        let path = repo_root.join("crates").join("broken");
        let diagnostic = workspace_member_from_entry_parts(
            &repo_root,
            "crates",
            &path,
            OsString::from("broken"),
            Err(io::Error::new(
                ErrorKind::PermissionDenied,
                "metadata denied",
            )),
        )
        .err()
        .ok_or_else(|| io::Error::other("expected workspace entry metadata diagnostic"))?;

        assert_eq!(
            diagnostic.category,
            GraphExtractionDiagnosticCategory::IoError
        );
        assert_eq!(diagnostic.path.as_deref(), Some("crates/broken"));
        assert_eq!(diagnostic.language.as_deref(), Some("rust"));
        assert!(diagnostic
            .message
            .contains("failed to inspect Cargo workspace member entry"));
        Ok(())
    }
}

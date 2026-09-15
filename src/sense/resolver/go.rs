use std::{collections::BTreeMap, sync::Arc};

use super::{
    Candidate, Language, RepoPath, Resolution, SourceFile, SourceSnapshot, add_candidate,
    alias_resolution,
};

#[derive(Default)]
pub(super) struct Index {
    aliases: BTreeMap<String, Candidate>,
    representatives: BTreeMap<RepoPath, RepoPath>,
    module_paths: Vec<String>,
    configuration_errors: usize,
    has_go: bool,
}

impl Index {
    pub(super) fn build(
        snapshot: &SourceSnapshot,
        module_files: &BTreeMap<RepoPath, Arc<[u8]>>,
    ) -> Self {
        let packages = package_files(snapshot);
        let package_directories = packages.keys().map(String::as_str).collect::<Vec<_>>();
        let modules = modules(module_files, &package_directories);
        let mut index = Self {
            configuration_errors: modules.errors,
            module_paths: modules
                .records
                .iter()
                .filter_map(|record| record.module_path.clone())
                .collect(),
            ..Self::default()
        };
        index.has_go = !packages.is_empty();
        for (directory, files) in packages {
            index.add_package(&directory, &files, &modules.records);
        }
        index.module_paths.sort();
        index.module_paths.dedup();
        index
    }

    pub(super) fn logical_path(&self, file: &SourceFile) -> RepoPath {
        self.representatives
            .get(&file.path)
            .cloned()
            .unwrap_or_else(|| file.path.clone())
    }

    pub(super) fn logical_path_for(&self, path: &RepoPath) -> RepoPath {
        self.representatives
            .get(path)
            .cloned()
            .unwrap_or_else(|| path.clone())
    }

    pub(super) const fn configuration_errors(&self) -> usize {
        self.configuration_errors
    }

    pub(super) const fn has_go(&self) -> bool {
        self.has_go
    }

    pub(super) fn logical_paths(&self) -> impl Iterator<Item = &RepoPath> {
        self.representatives.values()
    }

    pub(super) fn resolve(&self, importer: &RepoPath, specifier: &str) -> Resolution {
        let resolution = alias_resolution(self.aliases.get(specifier));
        if !matches!(resolution, Resolution::Unresolved) {
            let importer = self.logical_path_for(importer);
            return match resolution {
                Resolution::Resolved(target) if target == importer => Resolution::SameFile,
                other => other,
            };
        }
        if self.module_paths.iter().any(|module| {
            specifier == module
                || specifier
                    .strip_prefix(module)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        }) {
            Resolution::Unresolved
        } else {
            Resolution::External
        }
    }

    fn add_package(&mut self, directory: &str, files: &[&SourceFile], modules: &[ModuleRecord]) {
        let production = files
            .iter()
            .find(|file| !file.language_mode.starts_with("go:test:"))
            .map(|file| file.path.clone());
        for file in files {
            let representative = if file.language_mode.starts_with("go:test:") {
                file.path.clone()
            } else {
                production.clone().unwrap_or_else(|| file.path.clone())
            };
            self.representatives
                .insert(file.path.clone(), representative);
        }
        let Some(target) = production else {
            return;
        };
        let Some(module) = enclosing_module(directory, modules) else {
            return;
        };
        let Some(module_path) = &module.module_path else {
            return;
        };
        let import_path = package_import_path(module, module_path, directory);
        add_candidate(&mut self.aliases, &import_path, &target);
    }
}

fn package_files(snapshot: &SourceSnapshot) -> BTreeMap<String, Vec<&SourceFile>> {
    let mut packages = BTreeMap::<String, Vec<&SourceFile>>::new();
    for file in snapshot
        .files()
        .filter(|file| file.language == Language::Go)
    {
        let Some(path) = file.path.as_utf8() else {
            continue;
        };
        packages
            .entry(parent(path).to_owned())
            .or_default()
            .push(file);
    }
    packages
}

fn package_import_path(module: &ModuleRecord, module_path: &str, directory: &str) -> String {
    let relative = if module.directory.is_empty() {
        directory
    } else {
        directory
            .strip_prefix(&module.directory)
            .and_then(|suffix| suffix.strip_prefix('/'))
            .unwrap_or_default()
    };
    if relative.is_empty() {
        module_path.into()
    } else {
        format!("{module_path}/{relative}")
    }
}

fn enclosing_module<'a>(directory: &str, modules: &'a [ModuleRecord]) -> Option<&'a ModuleRecord> {
    modules
        .iter()
        .filter(|module| directory_contains(&module.directory, directory))
        .max_by_key(|module| module.directory.len())
}

fn directory_contains(parent: &str, child: &str) -> bool {
    parent.is_empty()
        || parent == child
        || child
            .strip_prefix(parent)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(directory, _)| directory)
}

struct Modules {
    records: Vec<ModuleRecord>,
    errors: usize,
}

struct ModuleRecord {
    directory: String,
    module_path: Option<String>,
}

fn modules(files: &BTreeMap<RepoPath, Arc<[u8]>>, package_directories: &[&str]) -> Modules {
    let mut records = Vec::new();
    let mut errors = 0usize;
    for (path, bytes) in files {
        let directory = path.as_utf8().map_or("", parent).to_owned();
        if !package_directories
            .iter()
            .any(|package| directory_contains(&directory, package))
        {
            continue;
        }
        if let Ok(module_path) = parse_module_path(bytes) {
            records.push(ModuleRecord {
                directory,
                module_path: Some(module_path),
            });
        } else {
            errors = errors.saturating_add(1);
            records.push(ModuleRecord {
                directory,
                module_path: None,
            });
        }
    }
    Modules { records, errors }
}

fn parse_module_path(bytes: &[u8]) -> Result<String, ()> {
    let source = std::str::from_utf8(bytes).map_err(|_| ())?;
    let mut module_path = None;
    let mut block_comment = false;
    for line in source.lines() {
        let cleaned = strip_comments(line, &mut block_comment);
        let mut fields = cleaned.split_ascii_whitespace();
        if fields.next() != Some("module") {
            continue;
        }
        let candidate = fields.next().ok_or(())?;
        let candidate = unquote_module_path(candidate).ok_or(())?;
        if fields.next().is_some() || module_path.is_some() || !valid_module_path(&candidate) {
            return Err(());
        }
        module_path = Some(candidate);
    }
    if block_comment {
        return Err(());
    }
    module_path.ok_or(())
}

fn unquote_module_path(value: &str) -> Option<String> {
    if let Some(raw) = value
        .strip_prefix('`')
        .and_then(|item| item.strip_suffix('`'))
    {
        return (!raw.contains(['\r', '\n', '`'])).then(|| raw.to_owned());
    }
    if let Some(quoted) = value
        .strip_prefix('"')
        .and_then(|item| item.strip_suffix('"'))
    {
        let mut result = String::new();
        let mut chars = quoted.chars();
        while let Some(character) = chars.next() {
            if character != '\\' {
                result.push(character);
                continue;
            }
            match chars.next()? {
                '\\' => result.push('\\'),
                '"' => result.push('"'),
                _ => return None,
            }
        }
        return Some(result);
    }
    Some(value.to_owned())
}

fn strip_comments<'a>(line: &'a str, block_comment: &mut bool) -> &'a str {
    if *block_comment {
        if let Some((_, remainder)) = line.split_once("*/") {
            *block_comment = false;
            return strip_comments(remainder, block_comment);
        }
        return "";
    }
    let line = line.split_once("//").map_or(line, |(before, _)| before);
    if let Some((before, _)) = line.split_once("/*") {
        *block_comment = !line.contains("*/");
        before
    } else {
        line
    }
}

fn valid_module_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.ends_with('/')
        && !path.contains("//")
        && path
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'\\' | b'"' | b'\''))
        && path
            .split('/')
            .all(|segment| !matches!(segment, "" | "." | ".."))
}

#[cfg(test)]
mod tests {
    use super::parse_module_path;

    #[test]
    fn module_directive_is_strict_and_comment_aware() {
        assert_eq!(
            parse_module_path(b"module example.com/project // owner\n\ngo 1.24\n"),
            Ok("example.com/project".into())
        );
        assert_eq!(
            parse_module_path(b"module \"example.com/quoted\"\n"),
            Ok("example.com/quoted".into())
        );
        assert!(parse_module_path(b"module ../escape\n").is_err());
        assert!(parse_module_path(b"module one\nmodule two\n").is_err());
        assert!(parse_module_path(b"go 1.24\n").is_err());
    }
}

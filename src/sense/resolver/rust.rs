use std::collections::{BTreeMap, BTreeSet, VecDeque};

use super::{
    Candidate, DependencyReferenceKind, Language, RepoPath, Resolution, SourceFile, SourceSnapshot,
    add_candidate, alias_resolution, facts,
};

#[derive(Default)]
pub(super) struct Index {
    modules: BTreeMap<String, Candidate>,
    roots: BTreeSet<String>,
    file_modules: BTreeMap<RepoPath, String>,
    root_files: BTreeSet<RepoPath>,
    confirmed_files: BTreeSet<RepoPath>,
}

impl Index {
    pub(super) fn add_file(&mut self, file: &SourceFile, path: &str) {
        let is_root = is_conventional_root(path);
        let Some(module) = module_key(path, is_root) else {
            return;
        };
        add_candidate(&mut self.modules, &module, &file.path);
        self.file_modules.insert(file.path.clone(), module.clone());
        if is_root {
            self.roots.insert(module);
            self.root_files.insert(file.path.clone());
        }
    }

    pub(super) fn confirm_module_trees(
        &mut self,
        snapshot: &SourceSnapshot,
        file_facts: &facts::FactMap,
        parser_options: &[u8],
    ) {
        let mut pending = self.root_files.iter().cloned().collect::<VecDeque<_>>();
        while let Some(path) = pending.pop_front() {
            if !self.confirmed_files.insert(path.clone()) {
                continue;
            }
            let Some(file) = snapshot.read(&path) else {
                continue;
            };
            let Some(file_facts) = file_facts.get(&facts::key(&file, parser_options)) else {
                continue;
            };
            for reference in file_facts
                .dependencies
                .references
                .iter()
                .filter(|reference| reference.kind == DependencyReferenceKind::RustModule)
            {
                if let Resolution::Resolved(target) =
                    resolve_module_unchecked(&file.path, &reference.specifier, self)
                {
                    pending.push_back(target);
                }
            }
        }
    }
}

pub(super) fn index_is_stable(
    before: &SourceSnapshot,
    after: &SourceSnapshot,
    changed_paths: &BTreeSet<RepoPath>,
) -> bool {
    changed_paths.iter().all(|path| {
        let before_file = before.read(path);
        let after_file = after.read(path);
        let rust_changed = before_file
            .as_ref()
            .is_some_and(|file| file.language == Language::Rust)
            || after_file
                .as_ref()
                .is_some_and(|file| file.language == Language::Rust);
        !rust_changed
            || before_file.as_ref().map(|file| file.content_id)
                == after_file.as_ref().map(|file| file.content_id)
    })
}

pub(super) fn resolve_module(importer: &RepoPath, specifier: &str, index: &Index) -> Resolution {
    if !index.confirmed_files.contains(importer) {
        return Resolution::Unresolved;
    }
    require_confirmed_target(resolve_module_unchecked(importer, specifier, index), index)
}

fn resolve_module_unchecked(importer: &RepoPath, specifier: &str, index: &Index) -> Resolution {
    let Some(base) = index.file_modules.get(importer) else {
        return Resolution::Unresolved;
    };
    resolve_segments(importer, base, specifier.split("::"), index, false)
}

pub(super) fn resolve_use(importer: &RepoPath, specifier: &str, index: &Index) -> Resolution {
    if !index.confirmed_files.contains(importer) {
        return Resolution::Unresolved;
    }
    let Some(current) = index.file_modules.get(importer).cloned() else {
        return Resolution::Unresolved;
    };
    let mut segments = specifier.split("::").peekable();
    let Some(first) = segments.peek().copied() else {
        return Resolution::Unresolved;
    };
    let Some((base, anchored)) = resolve_anchor(first, &current, &mut segments, index) else {
        return Resolution::Unresolved;
    };
    let resolution = resolve_segments(importer, &base, segments, index, anchored);
    let resolution = require_confirmed_target(resolution, index);
    if !anchored && matches!(resolution, Resolution::Unresolved) {
        Resolution::External
    } else {
        resolution
    }
}

fn resolve_anchor<'a>(
    first: &str,
    current: &str,
    segments: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
    index: &Index,
) -> Option<(String, bool)> {
    match first {
        "crate" => {
            segments.next();
            Some((crate_root(current, index)?, true))
        }
        "self" => {
            segments.next();
            Some((current.into(), true))
        }
        "super" => Some((super_base(current, segments)?, true)),
        _ => Some((current.into(), false)),
    }
}

fn super_base<'a>(
    current: &str,
    segments: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Option<String> {
    let mut base = current.to_owned();
    while segments.peek().is_some_and(|segment| *segment == "super") {
        segments.next();
        base = parent_module_key(&base)?;
    }
    Some(base)
}

fn require_confirmed_target(resolution: Resolution, index: &Index) -> Resolution {
    match resolution {
        Resolution::Resolved(path) if !index.confirmed_files.contains(&path) => {
            Resolution::Unresolved
        }
        resolution => resolution,
    }
}

fn resolve_segments<'a>(
    importer: &RepoPath,
    base: &str,
    segments: impl IntoIterator<Item = &'a str>,
    index: &Index,
    allow_base: bool,
) -> Resolution {
    let mut key = base.to_owned();
    let mut best = allow_base.then(|| index.modules.get(base)).flatten();
    for segment in segments {
        if segment.is_empty() || matches!(segment, "." | "..") {
            return Resolution::Unresolved;
        }
        if !key.is_empty() {
            key.push('/');
        }
        key.push_str(segment);
        if let Some(candidate) = index.modules.get(&key) {
            best = Some(candidate);
        }
    }
    match best {
        Some(Candidate::Unique(path)) if path == importer => Resolution::SameFile,
        Some(candidate) => alias_resolution(Some(candidate)),
        None => Resolution::Unresolved,
    }
}

fn crate_root(module: &str, index: &Index) -> Option<String> {
    let mut candidate = Some(module.to_owned());
    while let Some(current) = candidate {
        if index.roots.contains(&current) {
            return Some(current);
        }
        candidate = parent_module_key(&current);
    }
    None
}

fn module_key(path: &str, is_root: bool) -> Option<String> {
    let stem = path.strip_suffix(".rs")?;
    let (parent, name) = stem.rsplit_once('/').unwrap_or(("", stem));
    if is_root || name == "mod" {
        Some(parent.into())
    } else {
        Some(stem.into())
    }
}

fn is_conventional_root(path: &str) -> bool {
    let parts = path.split('/').collect::<Vec<_>>();
    matches!(
        parts.as_slice(),
        [.., "src", "lib.rs" | "main.rs"] | [.., "src", "bin", _, "main.rs"]
    )
}

fn parent_module_key(module: &str) -> Option<String> {
    module.rsplit_once('/').map(|(parent, _)| parent.into())
}

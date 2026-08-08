use super::*;

pub(super) struct Imports;

pub(super) trait RustImports {
    fn imports_from_use_tree(tree: &UseTree) -> Vec<ImportFact>;
    fn resolve_rust_import_path(
        specifier: &str,
        from_path: &str,
        known_files: &BTreeSet<String>,
    ) -> Option<String>;
    fn file_module_name(path: &str) -> String;
}

impl RustImports for Imports {
    fn imports_from_use_tree(tree: &UseTree) -> Vec<ImportFact> {
        let mut imports = Vec::new();
        collect_use_tree(tree, Vec::new(), &mut imports);
        imports
    }

    fn resolve_rust_import_path(
        specifier: &str,
        from_path: &str,
        known_files: &BTreeSet<String>,
    ) -> Option<String> {
        let parts = specifier
            .split("::")
            .filter(|part| !part.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        match parts.first().map(String::as_str) {
            Some("crate") => resolve_crate_path(from_path, parts.iter().skip(1), known_files),
            Some("self") => resolve_relative_path(from_path, parts.iter().skip(1), known_files),
            Some("super") => resolve_super_path(from_path, parts.iter().skip(1), known_files),
            Some(_) => resolve_relative_path(from_path, parts.iter(), known_files),
            None => crate_root_file_for(from_path, known_files),
        }
    }

    fn file_module_name(path: &str) -> String {
        let file_name = Path::new(path)
            .file_stem()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "crate".to_string());
        if file_name == "lib" || file_name == "main" {
            return "crate".to_string();
        }
        if file_name == "mod" {
            return Path::new(path)
                .parent()
                .and_then(Path::file_name)
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or(file_name);
        }
        file_name
    }
}

fn collect_use_tree(tree: &UseTree, prefix: Vec<String>, imports: &mut Vec<ImportFact>) {
    match tree {
        UseTree::Path(path) => {
            let mut next_prefix = prefix;
            next_prefix.push(path.ident.to_string());
            collect_use_tree(&path.tree, next_prefix, imports);
        }
        UseTree::Name(name) => push_use_binding(imports, &prefix, &name.ident.to_string(), None),
        UseTree::Rename(rename) => push_use_binding(
            imports,
            &prefix,
            &rename.ident.to_string(),
            Some(rename.rename.to_string()),
        ),
        UseTree::Glob(_) => {
            imports.push(ImportFact {
                specifier: prefix.join("::"),
                bindings: vec![ImportBinding {
                    local: "*".to_string(),
                    imported: "*".to_string(),
                }],
            });
        }
        UseTree::Group(group) => {
            for item in &group.items {
                collect_use_tree(item, prefix.clone(), imports);
            }
        }
    }
}

fn push_use_binding(
    imports: &mut Vec<ImportFact>,
    prefix: &[String],
    imported_name: &str,
    renamed: Option<String>,
) {
    let local = renamed.unwrap_or_else(|| imported_name.to_string());
    let module_import = is_probable_module_import(prefix, imported_name);
    let specifier = if module_import {
        path_with_tail(prefix, imported_name)
    } else {
        prefix.join("::")
    };
    let imported = if module_import {
        "*".to_string()
    } else {
        imported_name.to_string()
    };
    imports.push(ImportFact {
        specifier,
        bindings: vec![ImportBinding { local, imported }],
    });
}

fn is_probable_module_import(prefix: &[String], imported_name: &str) -> bool {
    prefix
        .last()
        .is_some_and(|part| part == "crate" || part == "self" || part == "super")
        && imported_name.chars().next().is_some_and(char::is_lowercase)
}

fn path_with_tail(prefix: &[String], tail: &str) -> String {
    let mut parts = prefix.to_vec();
    parts.push(tail.to_string());
    parts.join("::")
}

fn resolve_crate_path<'a>(
    from_path: &str,
    module_parts: impl Iterator<Item = &'a String>,
    known_files: &BTreeSet<String>,
) -> Option<String> {
    let source_dir = crate_source_dir_for(from_path, known_files)?;
    let module_parts = module_parts.cloned().collect::<Vec<_>>();
    if module_parts.is_empty() {
        return crate_root_file_in_source_dir(&source_dir, known_files);
    }
    resolve_module_candidates(&source_dir, &module_parts, known_files)
}

fn resolve_relative_path<'a>(
    from_path: &str,
    module_parts: impl Iterator<Item = &'a String>,
    known_files: &BTreeSet<String>,
) -> Option<String> {
    let module_parts = module_parts.cloned().collect::<Vec<_>>();
    if module_parts.is_empty() {
        return Some(from_path.to_string());
    }
    let base_dir = module_dir_for_path(from_path);
    resolve_module_candidates(&base_dir, &module_parts, known_files)
}

fn resolve_super_path<'a>(
    from_path: &str,
    module_parts: impl Iterator<Item = &'a String>,
    known_files: &BTreeSet<String>,
) -> Option<String> {
    let parent = Path::new(from_path)
        .parent()
        .and_then(Path::parent)
        .map(Syntax::path_to_string)
        .unwrap_or_default();
    let module_parts = module_parts.cloned().collect::<Vec<_>>();
    if module_parts.is_empty() {
        return None;
    }
    let base_dir = parent_module_dir_for_path(from_path).unwrap_or(parent);
    resolve_module_candidates(&base_dir, &module_parts, known_files)
}

fn resolve_module_candidates(
    base_dir: &str,
    module_parts: &[String],
    known_files: &BTreeSet<String>,
) -> Option<String> {
    module_file_candidates(base_dir, module_parts)
        .into_iter()
        .find(|candidate| known_files.contains(candidate))
}

fn module_file_candidates(base_dir: &str, module_parts: &[String]) -> Vec<String> {
    let mut module_path = PathBuf::from(base_dir);
    for part in module_parts {
        module_path.push(part);
    }
    let file_candidate = format!("{}.rs", Syntax::path_to_string(&module_path));
    let mut mod_candidate = module_path;
    mod_candidate.push("mod.rs");
    vec![file_candidate, Syntax::path_to_string(&mod_candidate)]
}

fn crate_root_file_for(from_path: &str, known_files: &BTreeSet<String>) -> Option<String> {
    let source_dir = crate_source_dir_for(from_path, known_files)?;
    crate_root_file_in_source_dir(&source_dir, known_files)
}

fn crate_source_dir_for(from_path: &str, known_files: &BTreeSet<String>) -> Option<String> {
    let mut current = Path::new(from_path).parent();
    while let Some(directory) = current {
        let source_dir = Syntax::path_to_string(directory);
        if crate_root_file_in_source_dir(&source_dir, known_files).is_some() {
            return Some(source_dir);
        }
        current = directory.parent();
    }
    None
}

fn crate_root_file_in_source_dir(
    source_dir: &str,
    known_files: &BTreeSet<String>,
) -> Option<String> {
    let lib = join_path(source_dir, "lib.rs");
    if known_files.contains(&lib) {
        return Some(lib);
    }
    let main = join_path(source_dir, "main.rs");
    if known_files.contains(&main) {
        return Some(main);
    }
    None
}

fn module_dir_for_path(path: &str) -> String {
    let path = Path::new(path);
    let parent = path
        .parent()
        .map(Syntax::path_to_string)
        .unwrap_or_default();
    let Some(stem) = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
    else {
        return parent;
    };
    if stem == "lib" || stem == "main" || stem == "mod" {
        return parent;
    }
    join_path(&parent, &stem)
}

fn parent_module_dir_for_path(path: &str) -> Option<String> {
    Path::new(&module_dir_for_path(path))
        .parent()
        .map(Syntax::path_to_string)
}

fn join_path(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_string()
    } else {
        format!("{parent}/{child}")
    }
}

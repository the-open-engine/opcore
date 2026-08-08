use super::*;

pub(super) struct Resolution;

pub(super) trait FactResolution {
    fn file_id(path: &str) -> String;
    fn insert_edge(edges: &mut BTreeMap<String, GraphFactEdge>, edge: EdgeDraft<'_>);
    fn resolve_name(
        file_path: &str,
        name: &str,
        context: &NameResolutionContext<'_>,
    ) -> Option<String>;
    fn resolve_imported_name(
        target_path: &str,
        imported: &str,
        context: &NameResolutionContext<'_>,
    ) -> Option<String>;
    fn is_python_source_path(path: &str) -> bool;
    fn is_rust_source_path(path: &str) -> bool;
    fn known_files(file_facts: &[FileFacts]) -> BTreeSet<String>;
    fn append_path_traversal_blocker(diagnostics: &mut Vec<GraphExtractionDiagnostic>);
}

impl FactResolution for Resolution {
    fn file_id(path: &str) -> String {
        format!("file:{path}")
    }

    fn insert_edge(edges: &mut BTreeMap<String, GraphFactEdge>, edge: EdgeDraft<'_>) {
        if edge.from == edge.to {
            return;
        }
        let id = format!("edge:{}:{}->{}", edge.kind, edge.from, edge.to);
        edges.entry(id.clone()).or_insert_with(|| GraphFactEdge {
            id: Some(id),
            kind: edge.kind.to_string(),
            from: edge.from.to_string(),
            to: edge.to.to_string(),
            attributes: None,
        });
    }

    fn resolve_name(
        file_path: &str,
        name: &str,
        context: &NameResolutionContext<'_>,
    ) -> Option<String> {
        if let Some(local) = context
            .declarations_by_file
            .get(file_path)
            .and_then(|declarations| declarations.get(name))
        {
            return Some(local.clone());
        }
        if name.contains('.') {
            return resolve_dotted_name(file_path, name, context);
        }
        if let Some(target) = context
            .imports_by_file
            .get(file_path)
            .and_then(|imports| imports.get(name))
        {
            if target.imported != "*" {
                if let Some(target) =
                    Self::resolve_imported_name(&target.path, &target.imported, context)
                {
                    return Some(target);
                }
            }
        }
        None
    }

    fn resolve_imported_name(
        target_path: &str,
        imported: &str,
        context: &NameResolutionContext<'_>,
    ) -> Option<String> {
        context
            .export_aliases_by_file
            .get(target_path)
            .and_then(|aliases| aliases.get(imported))
            .cloned()
    }

    fn is_python_source_path(path: &str) -> bool {
        path.ends_with(".py") || path.ends_with(".pyi")
    }

    fn is_rust_source_path(path: &str) -> bool {
        path.ends_with(".rs")
    }

    fn known_files(file_facts: &[FileFacts]) -> BTreeSet<String> {
        file_facts
            .iter()
            .map(|facts| facts.path.clone())
            .collect::<BTreeSet<_>>()
    }

    fn append_path_traversal_blocker(diagnostics: &mut Vec<GraphExtractionDiagnostic>) {
        let has_path_traversal = diagnostics.iter().any(|diagnostic| {
            diagnostic.category == GraphExtractionDiagnosticCategory::PathTraversal
        });
        if has_path_traversal {
            diagnostics.push(error(
                GraphExtractionDiagnosticCategory::PathTraversal,
                "path traversal diagnostics blocked graph availability",
                None,
                None,
            ));
        }
    }
}

fn resolve_dotted_name(
    file_path: &str,
    name: &str,
    context: &NameResolutionContext<'_>,
) -> Option<String> {
    let parts = name.split('.').collect::<Vec<_>>();
    let head = parts.first()?;
    let target = context
        .imports_by_file
        .get(file_path)
        .and_then(|imports| imports.get(*head))?;
    if target.imported == "*" {
        for candidate in namespace_import_member_candidates(&parts, &target.path) {
            if let Some(target) =
                Resolution::resolve_imported_name(&target.path, &candidate, context)
            {
                return Some(target);
            }
        }
        return None;
    }
    Resolution::resolve_imported_name(&target.path, &target.imported, context)
}

fn namespace_import_member_candidates(parts: &[&str], target_path: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    let module_parts = module_parts_for_path(target_path);
    if let Some(consumed) = longest_module_prefix_match(parts, &module_parts) {
        if let Some(candidate) = parts.get(consumed..) {
            candidates.push(candidate.join("."));
        }
    }
    if let Some(candidate) = parts.get(1..) {
        candidates.push(candidate.join("."));
    }
    if let Some(last) = parts.last() {
        candidates.push((*last).to_string());
    }
    deduplicate(candidates)
}

fn longest_module_prefix_match(parts: &[&str], module_parts: &[String]) -> Option<usize> {
    let max_len = parts.len().min(module_parts.len());
    (1..=max_len).rev().find(|len| {
        let len = *len;
        let Some(start) = module_parts.len().checked_sub(len) else {
            return false;
        };
        let Some(module_suffix) = module_parts.get(start..) else {
            return false;
        };
        let Some(parts_prefix) = parts.get(..len) else {
            return false;
        };
        module_suffix
            .iter()
            .map(String::as_str)
            .eq(parts_prefix.iter().copied())
    })
}

fn module_parts_for_path(path: &str) -> Vec<String> {
    let without_extension = path
        .strip_suffix(".py")
        .or_else(|| path.strip_suffix(".pyi"))
        .or_else(|| path.strip_suffix(".mts"))
        .or_else(|| path.strip_suffix(".cts"))
        .or_else(|| path.strip_suffix(".ts"))
        .or_else(|| path.strip_suffix(".tsx"))
        .or_else(|| path.strip_suffix(".js"))
        .or_else(|| path.strip_suffix(".jsx"))
        .or_else(|| path.strip_suffix(".rs"))
        .unwrap_or(path);
    let mut parts = without_extension
        .split('/')
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if parts.last().is_some_and(|part| part == "__init__") {
        parts.pop();
    }
    parts
}

fn deduplicate(values: Vec<String>) -> Vec<String> {
    values.into_iter().fold(Vec::new(), |mut unique, value| {
        if !value.is_empty() && !unique.contains(&value) {
            unique.push(value);
        }
        unique
    })
}

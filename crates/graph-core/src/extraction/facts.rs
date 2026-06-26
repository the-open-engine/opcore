use super::diagnostics::error;
use super::discovery::DiscoveredSource;
use super::python_imports;
use super::tsconfig::{resolve_import, TsConfig};
use super::SourceLanguage;
use crate::protocol::{
    GraphExtractionDiagnostic, GraphExtractionDiagnosticCategory, GraphFactEdge, GraphFactNode,
};
use oxc_ast::ast::Program;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
mod collector;
mod python;

use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileFacts {
    pub path: String,
    pub file_node: GraphFactNode,
    pub nodes: BTreeMap<String, GraphFactNode>,
    pub edges: BTreeMap<String, GraphFactEdge>,
    pub declarations: BTreeMap<String, String>,
    pub export_aliases: BTreeMap<String, String>,
    pub re_exports: Vec<ReExportFact>,
    pub imports: Vec<ImportFact>,
    pub references: Vec<ReferenceFact>,
    pub heritage: Vec<HeritageFact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportFact {
    pub specifier: String,
    pub bindings: Vec<ImportBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportBinding {
    pub local: String,
    pub imported: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReExportFact {
    pub specifier: String,
    pub imported: String,
    pub exported: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferenceFact {
    pub from: String,
    pub name: String,
    pub is_test: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeritageFact {
    pub from: String,
    pub name: String,
    pub kind: String,
}

type DeclarationsByFile = BTreeMap<String, BTreeMap<String, String>>;
type ExportAliasesByFile = BTreeMap<String, BTreeMap<String, String>>;
type ImportsByFile = BTreeMap<String, BTreeMap<String, ImportTarget>>;

struct NameResolutionContext<'a> {
    declarations_by_file: &'a DeclarationsByFile,
    export_aliases_by_file: &'a ExportAliasesByFile,
    imports_by_file: &'a ImportsByFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ImportTarget {
    path: String,
    imported: String,
}

struct EdgeDraft<'a> {
    kind: &'a str,
    from: &'a str,
    to: &'a str,
}

impl<'a> EdgeDraft<'a> {
    fn new(kind: &'a str, from: &'a str, to: &'a str) -> Self {
        Self { kind, from, to }
    }
}

pub fn file_node(source: &DiscoveredSource) -> GraphFactNode {
    let parser = match source.language {
        SourceLanguage::Python => "tree_sitter_python",
        SourceLanguage::TypeScript
        | SourceLanguage::TypeScriptJsx
        | SourceLanguage::JavaScript
        | SourceLanguage::JavaScriptJsx => "oxc_parser",
    };
    GraphFactNode {
        id: file_id(&source.relative_path),
        kind: "File".to_string(),
        path: Some(source.relative_path.clone()),
        name: None,
        attributes: Some(json!({
            "language": source.language.as_str(),
            "sha256": source.sha256,
            "parser": parser
        })),
    }
}

pub fn file_facts_without_ast(source: &DiscoveredSource, file_node: GraphFactNode) -> FileFacts {
    FileFacts {
        path: source.relative_path.clone(),
        file_node,
        nodes: BTreeMap::new(),
        edges: BTreeMap::new(),
        declarations: BTreeMap::new(),
        export_aliases: BTreeMap::new(),
        re_exports: Vec::new(),
        imports: Vec::new(),
        references: Vec::new(),
        heritage: Vec::new(),
    }
}

pub fn extract_oxc_file_facts(
    source: &DiscoveredSource,
    file_node: GraphFactNode,
    program: &Program<'_>,
) -> FileFacts {
    collector::collect_file_facts(source.relative_path.clone(), file_node, program)
}

pub fn extract_python_file_facts(
    source: &DiscoveredSource,
    file_node: GraphFactNode,
    source_text: &str,
    tree: &tree_sitter::Tree,
) -> FileFacts {
    python::collect_file_facts(source.relative_path.clone(), file_node, source_text, tree)
}

pub fn finalize_facts(
    file_facts: &[FileFacts],
    tsconfig: Option<&TsConfig>,
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
) -> (Vec<GraphFactNode>, Vec<GraphFactEdge>) {
    let known_files = known_files(file_facts);
    let mut imports = ImportResolutionContext {
        known_files: &known_files,
        tsconfig,
        diagnostics,
    };
    let mut finalizer = FactFinalizer::new(file_facts);
    finalizer.resolve_imports(file_facts, &mut imports);
    finalizer.resolve_re_exports(file_facts);
    finalizer.resolve_links(file_facts);
    append_path_traversal_blocker(imports.diagnostics);
    finalizer.into_parts()
}

struct ImportResolutionContext<'a> {
    known_files: &'a BTreeSet<String>,
    tsconfig: Option<&'a TsConfig>,
    diagnostics: &'a mut Vec<GraphExtractionDiagnostic>,
}

impl ImportResolutionContext<'_> {
    fn resolve(&mut self, specifier: &str, path: &str) -> Option<String> {
        let resolution = if is_python_source_path(path) {
            python_imports::resolve_import(specifier, path, self.known_files)
        } else {
            resolve_import(specifier, path, self.known_files, self.tsconfig)
        };
        self.diagnostics.extend(resolution.diagnostics);
        resolution.resolved_path
    }
}

struct FactFinalizer {
    nodes: BTreeMap<String, GraphFactNode>,
    edges: BTreeMap<String, GraphFactEdge>,
    declarations_by_file: DeclarationsByFile,
    export_aliases_by_file: ExportAliasesByFile,
    imports_by_file: ImportsByFile,
}

impl FactFinalizer {
    fn new(file_facts: &[FileFacts]) -> Self {
        let mut finalizer = Self {
            nodes: BTreeMap::new(),
            edges: BTreeMap::new(),
            declarations_by_file: BTreeMap::new(),
            export_aliases_by_file: BTreeMap::new(),
            imports_by_file: BTreeMap::new(),
        };
        for facts in file_facts {
            finalizer.ingest_file(facts);
        }
        finalizer
    }

    fn ingest_file(&mut self, facts: &FileFacts) {
        self.nodes
            .insert(facts.file_node.id.clone(), facts.file_node.clone());
        self.declarations_by_file
            .insert(facts.path.clone(), facts.declarations.clone());
        self.export_aliases_by_file
            .insert(facts.path.clone(), facts.export_aliases.clone());
        self.nodes.extend(facts.nodes.clone());
        self.edges.extend(facts.edges.clone());
    }

    fn resolve_imports(&mut self, file_facts: &[FileFacts], imports: &mut ImportResolutionContext) {
        for facts in file_facts {
            for import in &facts.imports {
                if let Some(target_path) = imports.resolve(&import.specifier, &facts.path) {
                    self.register_import(facts, import, target_path);
                }
            }
        }
    }

    fn register_import(&mut self, facts: &FileFacts, import: &ImportFact, target_path: String) {
        let from = file_id(&facts.path);
        let to = file_id(&target_path);
        insert_edge(&mut self.edges, EdgeDraft::new("IMPORTS_FROM", &from, &to));
        insert_edge(&mut self.edges, EdgeDraft::new("DEPENDS_ON", &from, &to));
        for binding in &import.bindings {
            self.imports_by_file
                .entry(facts.path.clone())
                .or_default()
                .insert(
                    binding.local.clone(),
                    ImportTarget {
                        path: target_path.clone(),
                        imported: binding.imported.clone(),
                    },
                );
        }
    }

    fn resolve_re_exports(&mut self, file_facts: &[FileFacts]) {
        for _ in 0..file_facts.len() {
            let mut changed = false;
            for facts in file_facts {
                for re_export in &facts.re_exports {
                    let target = self
                        .imports_by_file
                        .get(&facts.path)
                        .and_then(|imports| imports.get(&re_export.exported))
                        .cloned();
                    let Some(target) = target else {
                        continue;
                    };
                    let resolved = {
                        let context = self.name_resolution_context();
                        resolve_imported_name(&target.path, &target.imported, &context)
                    };
                    let Some(resolved) = resolved else {
                        continue;
                    };
                    let aliases = self
                        .export_aliases_by_file
                        .entry(facts.path.clone())
                        .or_default();
                    if aliases.get(&re_export.exported) != Some(&resolved) {
                        aliases.insert(re_export.exported.clone(), resolved);
                        changed = true;
                    }
                    self.mark_file_export_supported(&facts.path, re_export);
                }
            }
            if !changed {
                break;
            }
        }
    }

    fn mark_file_export_supported(&mut self, path: &str, re_export: &ReExportFact) {
        let Some(file_node) = self.nodes.get_mut(&file_id(path)) else {
            return;
        };
        let Some(attributes) = file_node.attributes.as_mut().and_then(Value::as_object_mut) else {
            return;
        };
        let Some(exports) = attributes.get_mut("exports").and_then(Value::as_array_mut) else {
            return;
        };
        for export in exports {
            let Some(export) = export.as_object_mut() else {
                continue;
            };
            let matches = export.get("kind").and_then(Value::as_str) == Some("named")
                && export.get("source").and_then(Value::as_str) == Some(&re_export.specifier)
                && export.get("imported").and_then(Value::as_str) == Some(&re_export.imported)
                && export.get("exported").and_then(Value::as_str) == Some(&re_export.exported);
            if matches {
                export.insert("supportedSymbol".to_string(), Value::Bool(true));
            }
        }
    }

    fn resolve_links(&mut self, file_facts: &[FileFacts]) {
        for facts in file_facts {
            self.resolve_heritage(facts);
            self.resolve_references(facts);
        }
    }

    fn resolve_heritage(&mut self, facts: &FileFacts) {
        for heritage in &facts.heritage {
            let target = {
                let context = self.name_resolution_context();
                resolve_name(&facts.path, &heritage.name, &context)
            };
            if let Some(target) = target {
                insert_edge(
                    &mut self.edges,
                    EdgeDraft::new(&heritage.kind, &heritage.from, &target),
                );
            }
        }
    }

    fn resolve_references(&mut self, facts: &FileFacts) {
        for reference in &facts.references {
            let target = {
                let context = self.name_resolution_context();
                resolve_name(&facts.path, &reference.name, &context)
            };
            if let Some(target) = target {
                insert_edge(
                    &mut self.edges,
                    EdgeDraft::new("CALLS", &reference.from, &target),
                );
                if reference.is_test || reference.from.starts_with("test:") {
                    insert_edge(
                        &mut self.edges,
                        EdgeDraft::new("TESTED_BY", &target, &reference.from),
                    );
                }
            }
        }
    }

    fn name_resolution_context(&self) -> NameResolutionContext<'_> {
        NameResolutionContext {
            declarations_by_file: &self.declarations_by_file,
            export_aliases_by_file: &self.export_aliases_by_file,
            imports_by_file: &self.imports_by_file,
        }
    }

    fn into_parts(self) -> (Vec<GraphFactNode>, Vec<GraphFactEdge>) {
        (
            self.nodes.into_values().collect::<Vec<_>>(),
            self.edges.into_values().collect::<Vec<_>>(),
        )
    }
}

fn known_files(file_facts: &[FileFacts]) -> BTreeSet<String> {
    file_facts
        .iter()
        .map(|facts| facts.path.clone())
        .collect::<BTreeSet<_>>()
}

fn append_path_traversal_blocker(diagnostics: &mut Vec<GraphExtractionDiagnostic>) {
    let has_path_traversal = diagnostics
        .iter()
        .any(|diagnostic| diagnostic.category == GraphExtractionDiagnosticCategory::PathTraversal);
    if has_path_traversal {
        diagnostics.push(error(
            GraphExtractionDiagnosticCategory::PathTraversal,
            "path traversal diagnostics blocked graph availability",
            None,
            None,
        ));
    }
}

pub fn file_id(path: &str) -> String {
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
            if let Some(target) = resolve_imported_name(&target.path, &target.imported, context) {
                return Some(target);
            }
        }
    }
    None
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
            if let Some(target) = resolve_imported_name(&target.path, &candidate, context) {
                return Some(target);
            }
        }
        return None;
    }
    resolve_imported_name(&target.path, &target.imported, context)
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
        .or_else(|| path.strip_suffix(".ts"))
        .or_else(|| path.strip_suffix(".tsx"))
        .or_else(|| path.strip_suffix(".js"))
        .or_else(|| path.strip_suffix(".jsx"))
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

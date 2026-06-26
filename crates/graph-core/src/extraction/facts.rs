use super::diagnostics::error;
use super::discovery::DiscoveredSource;
use super::tsconfig::{resolve_import, TsConfig};
use crate::protocol::{
    GraphExtractionDiagnostic, GraphExtractionDiagnosticCategory, GraphFactEdge, GraphFactNode,
};
use oxc_ast::ast::Program;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
mod collector;

use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileFacts {
    pub path: String,
    pub file_node: GraphFactNode,
    pub nodes: BTreeMap<String, GraphFactNode>,
    pub edges: BTreeMap<String, GraphFactEdge>,
    pub declarations: BTreeMap<String, String>,
    #[serde(default)]
    pub qualified_declarations: BTreeMap<String, String>,
    #[serde(default)]
    pub rust_package_root: Option<String>,
    pub export_aliases: BTreeMap<String, String>,
    pub re_exports: Vec<ReExportFact>,
    pub imports: Vec<ImportFact>,
    #[serde(default)]
    pub rust_imports: Vec<RustImportFact>,
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
pub struct RustImportFact {
    pub target: String,
    #[serde(default)]
    pub local: Option<String>,
    pub dependency: Option<String>,
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
type QualifiedDeclarations = BTreeMap<String, String>;
type QualifiedDeclarationsByPackage = BTreeMap<String, QualifiedDeclarations>;
type RustPackageByFile = BTreeMap<String, String>;

struct NameResolutionContext<'a> {
    declarations_by_file: &'a DeclarationsByFile,
    qualified_declarations_by_rust_package: &'a QualifiedDeclarationsByPackage,
    rust_package_by_file: &'a RustPackageByFile,
    export_aliases_by_file: &'a ExportAliasesByFile,
    imports_by_file: &'a ImportsByFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ImportTarget {
    path: String,
    imported: String,
}

pub(super) struct EdgeDraft<'a> {
    kind: &'a str,
    from: &'a str,
    to: &'a str,
}

impl<'a> EdgeDraft<'a> {
    pub(super) fn new(kind: &'a str, from: &'a str, to: &'a str) -> Self {
        Self { kind, from, to }
    }
}

pub fn file_node(source: &DiscoveredSource) -> GraphFactNode {
    GraphFactNode {
        id: file_id(&source.relative_path),
        kind: "File".to_string(),
        path: Some(source.relative_path.clone()),
        name: None,
        attributes: Some(json!({
            "language": source.language.as_str(),
            "sha256": source.sha256,
            "parser": parser_name(source)
        })),
    }
}

fn parser_name(source: &DiscoveredSource) -> &'static str {
    match source.language {
        super::SourceLanguage::Rust => "syn",
        _ => "oxc_parser",
    }
}

pub fn file_facts_without_ast(source: &DiscoveredSource, file_node: GraphFactNode) -> FileFacts {
    FileFacts {
        path: source.relative_path.clone(),
        file_node,
        nodes: BTreeMap::new(),
        edges: BTreeMap::new(),
        declarations: BTreeMap::new(),
        qualified_declarations: BTreeMap::new(),
        rust_package_root: None,
        export_aliases: BTreeMap::new(),
        re_exports: Vec::new(),
        imports: Vec::new(),
        rust_imports: Vec::new(),
        references: Vec::new(),
        heritage: Vec::new(),
    }
}

pub fn extract_file_facts(
    source: &DiscoveredSource,
    file_node: GraphFactNode,
    program: &Program<'_>,
) -> FileFacts {
    collector::collect_file_facts(source.relative_path.clone(), file_node, program)
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
        let resolution = resolve_import(specifier, path, self.known_files, self.tsconfig);
        self.diagnostics.extend(resolution.diagnostics);
        resolution.resolved_path
    }
}

struct FactFinalizer {
    nodes: BTreeMap<String, GraphFactNode>,
    edges: BTreeMap<String, GraphFactEdge>,
    declarations_by_file: DeclarationsByFile,
    qualified_declarations_by_rust_package: QualifiedDeclarationsByPackage,
    rust_package_by_file: RustPackageByFile,
    export_aliases_by_file: ExportAliasesByFile,
    imports_by_file: ImportsByFile,
}

impl FactFinalizer {
    fn new(file_facts: &[FileFacts]) -> Self {
        let mut finalizer = Self {
            nodes: BTreeMap::new(),
            edges: BTreeMap::new(),
            declarations_by_file: BTreeMap::new(),
            qualified_declarations_by_rust_package: BTreeMap::new(),
            rust_package_by_file: BTreeMap::new(),
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
        if !facts.qualified_declarations.is_empty() {
            let package_root = facts.rust_package_root.clone().unwrap_or_default();
            self.rust_package_by_file
                .insert(facts.path.clone(), package_root.clone());
            self.qualified_declarations_by_rust_package
                .entry(package_root)
                .or_default()
                .extend(facts.qualified_declarations.clone());
        }
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
            for import in &facts.rust_imports {
                self.register_rust_import(facts, import);
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

    fn register_rust_import(&mut self, facts: &FileFacts, import: &RustImportFact) {
        let from = file_id(&facts.path);
        if let Some(dependency) = &import.dependency {
            let package_id = format!("package:{dependency}");
            self.nodes
                .entry(package_id.clone())
                .or_insert_with(|| GraphFactNode {
                    id: package_id.clone(),
                    kind: "package".to_string(),
                    path: None,
                    name: Some(dependency.clone()),
                    attributes: Some(json!({
                        "language": "rust"
                    })),
                });
            insert_edge(
                &mut self.edges,
                EdgeDraft::new("DEPENDS_ON", &from, &package_id),
            );
            return;
        }

        let target_id = {
            let context = self.name_resolution_context();
            resolve_qualified_name_for_file(&facts.path, &import.target, &context)
        };
        let Some(target_id) = target_id else { return };
        let target_path = self
            .nodes
            .get(&target_id)
            .and_then(|node| node.path.as_ref())
            .cloned();
        let Some(target_path) = target_path else {
            return;
        };
        let to = file_id(&target_path);
        insert_edge(&mut self.edges, EdgeDraft::new("IMPORTS_FROM", &from, &to));
        insert_edge(&mut self.edges, EdgeDraft::new("DEPENDS_ON", &from, &to));
        if let Some(local) = import
            .local
            .clone()
            .or_else(|| rust_import_local_name(&import.target))
        {
            self.imports_by_file
                .entry(facts.path.clone())
                .or_default()
                .insert(
                    local,
                    ImportTarget {
                        path: target_path,
                        imported: import.target.clone(),
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
                if reference.from.starts_with("test:") {
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
            qualified_declarations_by_rust_package: &self.qualified_declarations_by_rust_package,
            rust_package_by_file: &self.rust_package_by_file,
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

pub(super) fn insert_edge(edges: &mut BTreeMap<String, GraphFactEdge>, edge: EdgeDraft<'_>) {
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
    if name.contains('.') {
        return None;
    }
    if name.contains("::") {
        return resolve_rust_path_name(file_path, name, context);
    }
    if let Some(local) = context
        .declarations_by_file
        .get(file_path)
        .and_then(|declarations| declarations.get(name))
    {
        return Some(local.clone());
    }
    if let Some(target) = context
        .imports_by_file
        .get(file_path)
        .and_then(|imports| imports.get(name))
    {
        if target.imported != "*" {
            if target.imported.contains("::") {
                return resolve_qualified_name_for_file(&target.path, &target.imported, context);
            }
            if let Some(target) = resolve_imported_name(&target.path, &target.imported, context) {
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
    if imported.contains("::") {
        return resolve_qualified_name_for_file(target_path, imported, context);
    }
    context
        .export_aliases_by_file
        .get(target_path)
        .and_then(|aliases| aliases.get(imported))
        .cloned()
}

fn resolve_rust_path_name(
    file_path: &str,
    name: &str,
    context: &NameResolutionContext<'_>,
) -> Option<String> {
    if let Some((alias, rest)) = split_first_rust_path_segment(name) {
        if let Some(import) = context
            .imports_by_file
            .get(file_path)
            .and_then(|imports| imports.get(alias))
        {
            let target_name = append_rust_path(&import.imported, rest);
            if let Some(target) =
                resolve_qualified_name_for_file(&import.path, &target_name, context)
            {
                return Some(target);
            }
        }
    }
    resolve_qualified_name_for_file(file_path, name, context)
}

fn resolve_qualified_name_for_file(
    file_path: &str,
    name: &str,
    context: &NameResolutionContext<'_>,
) -> Option<String> {
    let package_root = context
        .rust_package_by_file
        .get(file_path)
        .map(String::as_str)
        .unwrap_or_default();
    let declarations = context
        .qualified_declarations_by_rust_package
        .get(package_root)?;
    resolve_qualified_name_in_package(name, declarations)
}

fn resolve_qualified_name_in_package(
    name: &str,
    declarations: &QualifiedDeclarations,
) -> Option<String> {
    if let Some(target) = declarations.get(name) {
        return Some(target.clone());
    }
    let crate_name = format!("crate::{name}");
    if let Some(target) = declarations.get(&crate_name) {
        return Some(target.clone());
    }
    let suffix = format!("::{name}");
    declarations
        .iter()
        .find_map(|(qualified, id)| qualified.ends_with(&suffix).then(|| id.clone()))
}

fn split_first_rust_path_segment(name: &str) -> Option<(&str, &str)> {
    name.split_once("::").filter(|(first, _)| !first.is_empty())
}

fn append_rust_path(base: &str, rest: &str) -> String {
    if rest.is_empty() {
        base.to_string()
    } else {
        format!("{base}::{rest}")
    }
}

fn rust_import_local_name(target: &str) -> Option<String> {
    target
        .split("::")
        .filter(|segment| !segment.is_empty())
        .last()
        .map(ToString::to_string)
}

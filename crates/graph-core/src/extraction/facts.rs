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
mod resolution;
mod rust;

use resolution::{FactResolution, Resolution};
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
        SourceLanguage::Rust => "syn",
        SourceLanguage::TypeScript
        | SourceLanguage::TypeScriptJsx
        | SourceLanguage::JavaScript
        | SourceLanguage::JavaScriptJsx => "oxc_parser",
    };
    GraphFactNode {
        id: Resolution::file_id(&source.relative_path),
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

pub fn extract_rust_file_facts(
    source: &DiscoveredSource,
    file_node: GraphFactNode,
    syntax: &syn::File,
) -> FileFacts {
    rust::collect_file_facts(source.relative_path.clone(), file_node, syntax)
}

pub fn finalize_facts(
    file_facts: &[FileFacts],
    tsconfig: Option<&TsConfig>,
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
) -> (Vec<GraphFactNode>, Vec<GraphFactEdge>) {
    let known_files = Resolution::known_files(file_facts);
    let mut imports = ImportResolutionContext {
        known_files: &known_files,
        tsconfig,
        diagnostics,
    };
    let mut finalizer = FactFinalizer::new(file_facts);
    finalizer.resolve_imports(file_facts, &mut imports);
    finalizer.resolve_re_exports(file_facts);
    finalizer.resolve_links(file_facts);
    Resolution::append_path_traversal_blocker(imports.diagnostics);
    finalizer.into_parts()
}

struct ImportResolutionContext<'a> {
    known_files: &'a BTreeSet<String>,
    tsconfig: Option<&'a TsConfig>,
    diagnostics: &'a mut Vec<GraphExtractionDiagnostic>,
}

impl ImportResolutionContext<'_> {
    fn resolve(&mut self, specifier: &str, path: &str) -> Option<String> {
        let resolution = if Resolution::is_python_source_path(path) {
            python_imports::resolve_import(specifier, path, self.known_files)
        } else if Resolution::is_rust_source_path(path) {
            rust::resolve_import(specifier, path, self.known_files)
        } else {
            resolve_import(specifier, path, self.known_files, self.tsconfig)
        };
        self.diagnostics.extend(resolution.diagnostics);
        resolution.resolved_path
    }

    fn resolve_python_imported_submodule(
        &self,
        specifier: &str,
        imported: &str,
        path: &str,
    ) -> Option<String> {
        let submodule_specifier = python_submodule_specifier(specifier, imported)?;
        python_imports::resolve_import(&submodule_specifier, path, self.known_files).resolved_path
    }
}

fn python_submodule_specifier(specifier: &str, imported: &str) -> Option<String> {
    if specifier.is_empty() || imported.is_empty() || imported == "*" {
        return None;
    }
    let separator = if specifier.ends_with('.') { "" } else { "." };
    Some(format!("{specifier}{separator}{imported}"))
}

fn is_conventional_script_test_path(path: &str) -> bool {
    let Some((stem, extension)) = path.rsplit_once('.') else {
        return false;
    };
    let is_script = matches!(
        extension,
        "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs"
    );
    is_script
        && (path.split('/').any(|segment| segment == "__tests__")
            || stem.ends_with(".test")
            || stem.ends_with(".spec"))
}

fn set_node_attribute(node: &mut GraphFactNode, key: &str, value: Value) {
    node_attributes_object(node).insert(key.to_string(), value);
}

fn node_attributes_object(node: &mut GraphFactNode) -> &mut serde_json::Map<String, Value> {
    let attributes = node
        .attributes
        .get_or_insert_with(|| Value::Object(serde_json::Map::new()));
    loop {
        if let Value::Object(object) = attributes {
            return object;
        }
        *attributes = Value::Object(serde_json::Map::new());
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
                if Resolution::is_python_source_path(&facts.path)
                    && self.register_python_import(facts, import, imports)
                {
                    continue;
                }
                if let Some(target_path) = imports.resolve(&import.specifier, &facts.path) {
                    self.register_import(facts, import, target_path);
                }
            }
        }
    }

    fn register_import(&mut self, facts: &FileFacts, import: &ImportFact, target_path: String) {
        self.register_import_edge(&facts.path, &target_path);
        for binding in &import.bindings {
            self.register_import_binding(
                &facts.path,
                binding,
                ImportTarget {
                    path: target_path.clone(),
                    imported: binding.imported.clone(),
                },
            );
        }
    }

    fn register_python_import(
        &mut self,
        facts: &FileFacts,
        import: &ImportFact,
        imports: &mut ImportResolutionContext,
    ) -> bool {
        let mut fallback_bindings = Vec::new();
        let mut handled_submodule = false;
        for binding in &import.bindings {
            if let Some(target_path) = imports.resolve_python_imported_submodule(
                &import.specifier,
                &binding.imported,
                &facts.path,
            ) {
                self.register_import_binding(
                    &facts.path,
                    binding,
                    ImportTarget {
                        path: target_path,
                        imported: "*".to_string(),
                    },
                );
                handled_submodule = true;
            } else {
                fallback_bindings.push(binding);
            }
        }
        if !handled_submodule {
            return false;
        }
        if !fallback_bindings.is_empty() {
            if let Some(target_path) = imports.resolve(&import.specifier, &facts.path) {
                for binding in fallback_bindings {
                    self.register_import_binding(
                        &facts.path,
                        binding,
                        ImportTarget {
                            path: target_path.clone(),
                            imported: binding.imported.clone(),
                        },
                    );
                }
            }
        }
        true
    }

    fn register_import_binding(
        &mut self,
        facts_path: &str,
        binding: &ImportBinding,
        target: ImportTarget,
    ) {
        self.register_import_edge(facts_path, &target.path);
        self.imports_by_file
            .entry(facts_path.to_string())
            .or_default()
            .insert(binding.local.clone(), target);
    }

    fn register_import_edge(&mut self, facts_path: &str, target_path: &str) {
        let from = Resolution::file_id(facts_path);
        let to = Resolution::file_id(target_path);
        Resolution::insert_edge(&mut self.edges, EdgeDraft::new("IMPORTS_FROM", &from, &to));
        Resolution::insert_edge(&mut self.edges, EdgeDraft::new("DEPENDS_ON", &from, &to));
        if is_conventional_script_test_path(facts_path)
            && !is_conventional_script_test_path(target_path)
        {
            Resolution::insert_edge(&mut self.edges, EdgeDraft::new("TESTED_BY", &to, &from));
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
                        Resolution::resolve_imported_name(&target.path, &target.imported, &context)
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
        let Some(file_node) = self.nodes.get_mut(&Resolution::file_id(path)) else {
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
                Resolution::resolve_name(&facts.path, &heritage.name, &context)
            };
            if let Some(target) = target {
                Resolution::insert_edge(
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
                Resolution::resolve_name(&facts.path, &reference.name, &context)
            };
            if let Some(target) = target {
                Resolution::insert_edge(
                    &mut self.edges,
                    EdgeDraft::new("CALLS", &reference.from, &target),
                );
                if reference.is_test || reference.from.starts_with("test:") {
                    Resolution::insert_edge(
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

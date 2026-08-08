use super::{
    node_attributes_object, set_node_attribute, EdgeDraft, FactResolution, FileFacts, HeritageFact,
    ImportBinding, ImportFact, ReExportFact, ReferenceFact, Resolution,
};
use crate::protocol::{GraphFactEdge, GraphFactNode};
use oxc_ast::ast::{
    Argument, BindingPattern, CallExpression, Class, ExportAllDeclaration,
    ExportDefaultDeclaration, ExportDefaultDeclarationKind, ExportNamedDeclaration, Expression,
    Function, ImportDeclaration, ImportDeclarationSpecifier, ImportExpression, ModuleExportName,
    NewExpression, TSImportType, TSInterfaceDeclaration, TSTypeAliasDeclaration, TSTypeName,
    VariableDeclaration,
};
use oxc_ast_visit::{walk, Visit};
use oxc_syntax::scope::ScopeFlags;
use serde_json::{json, Value};
use std::collections::{btree_map::Entry, BTreeMap};

mod helpers;
mod visit;

use helpers::{CollectorHelpers, Helpers};
use visit::CollectProgram;

pub(super) fn collect_file_facts(
    path: String,
    file_node: GraphFactNode,
    program: &oxc_ast::ast::Program<'_>,
) -> FileFacts {
    let mut collector = FileFactCollector::new(path, file_node);
    collector.collect_program(program);
    collector.finish()
}

struct FileFactCollector {
    path: String,
    file_node: GraphFactNode,
    nodes: BTreeMap<String, GraphFactNode>,
    edges: BTreeMap<String, GraphFactEdge>,
    declarations: BTreeMap<String, String>,
    top_level_declarations: BTreeMap<String, String>,
    imports: Vec<ImportFact>,
    references: Vec<ReferenceFact>,
    heritage: Vec<HeritageFact>,
    export_aliases: BTreeMap<String, String>,
    re_exports: Vec<ReExportFact>,
    current_context: Option<String>,
    current_export: Option<ExportContext>,
    pending_exports: BTreeMap<String, ExportContext>,
    file_exports: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExportContext {
    export_kind: String,
    export_name: Option<String>,
}

impl ExportContext {
    fn named(export_name: Option<String>) -> Self {
        Self {
            export_kind: "named".to_string(),
            export_name,
        }
    }

    fn default() -> Self {
        Self {
            export_kind: "default".to_string(),
            export_name: Some("default".to_string()),
        }
    }

    fn export_name_for(&self, fallback: &str) -> String {
        self.export_name
            .clone()
            .unwrap_or_else(|| fallback.to_string())
    }
}

impl FileFactCollector {
    fn new(path: String, file_node: GraphFactNode) -> Self {
        Self {
            path,
            file_node,
            nodes: BTreeMap::new(),
            edges: BTreeMap::new(),
            declarations: BTreeMap::new(),
            top_level_declarations: BTreeMap::new(),
            imports: Vec::new(),
            references: Vec::new(),
            heritage: Vec::new(),
            export_aliases: BTreeMap::new(),
            re_exports: Vec::new(),
            current_context: None,
            current_export: None,
            pending_exports: BTreeMap::new(),
            file_exports: Vec::new(),
        }
    }

    fn finish(mut self) -> FileFacts {
        self.reconcile_file_exports();
        if !self.file_exports.is_empty() {
            set_node_attribute(
                &mut self.file_node,
                "exports",
                Value::Array(self.file_exports.clone()),
            );
        }
        FileFacts {
            path: self.path,
            file_node: self.file_node,
            nodes: self.nodes,
            edges: self.edges,
            declarations: self.declarations,
            export_aliases: self.export_aliases,
            re_exports: self.re_exports,
            imports: self.imports,
            references: self.references,
            heritage: self.heritage,
        }
    }

    fn reconcile_file_exports(&mut self) {
        for export in &mut self.file_exports {
            let Value::Object(export) = export else {
                continue;
            };
            let is_local_export = export.get("source").is_some_and(Value::is_null);
            if !is_local_export {
                continue;
            }
            let Some(local) = export.get("local").and_then(Value::as_str) else {
                export.insert("supportedSymbol".to_string(), Value::Bool(false));
                continue;
            };
            export.insert(
                "supportedSymbol".to_string(),
                Value::Bool(self.top_level_declarations.contains_key(local)),
            );
        }
    }

    fn add_declaration(&mut self, prefix: &str, kind: &str, name: &str) -> String {
        let id = format!("{prefix}:{}#{name}", self.path);
        let is_top_level = self.current_context.is_none();
        let export = if is_top_level {
            self.current_export
                .clone()
                .or_else(|| self.pending_exports.remove(name))
        } else {
            None
        };
        let register_default_alias = export
            .as_ref()
            .is_some_and(|export| Helpers::registers_default_export_alias(export, name));
        match self.nodes.entry(id.clone()) {
            Entry::Occupied(mut entry) => {
                if let Some(export) = &export {
                    Helpers::apply_export_attributes(entry.get_mut(), export, name);
                } else {
                    Helpers::ensure_export_attribute(entry.get_mut());
                }
            }
            Entry::Vacant(entry) => {
                let mut node = GraphFactNode {
                    id: id.clone(),
                    kind: kind.to_string(),
                    path: Some(self.path.clone()),
                    name: Some(name.to_string()),
                    attributes: Some(json!({
                        "exported": false
                    })),
                };
                if let Some(export) = &export {
                    Helpers::apply_export_attributes(&mut node, export, name);
                }
                entry.insert(node);
            }
        }
        self.declarations.insert(name.to_string(), id.clone());
        if is_top_level {
            self.top_level_declarations
                .insert(name.to_string(), id.clone());
            if let Some(export) = &export {
                self.register_export_alias(export, name, &id);
            }
        }
        if register_default_alias {
            self.declarations.insert("default".to_string(), id.clone());
            if is_top_level {
                self.top_level_declarations
                    .insert("default".to_string(), id.clone());
            }
        }
        let file = Resolution::file_id(&self.path);
        Resolution::insert_edge(&mut self.edges, EdgeDraft::new("CONTAINS", &file, &id));
        id
    }

    fn add_default_declaration(&mut self, prefix: &str, kind: &str) -> String {
        let name = "default";
        let id = format!("{prefix}:{}#{name}", self.path);
        match self.nodes.entry(id.clone()) {
            Entry::Occupied(mut entry) => {
                Helpers::apply_export_attributes(entry.get_mut(), &ExportContext::default(), name);
            }
            Entry::Vacant(entry) => {
                let mut node = GraphFactNode {
                    id: id.clone(),
                    kind: kind.to_string(),
                    path: Some(self.path.clone()),
                    name: Some(name.to_string()),
                    attributes: Some(json!({
                        "exported": false
                    })),
                };
                Helpers::apply_export_attributes(&mut node, &ExportContext::default(), name);
                entry.insert(node);
            }
        }
        self.declarations.insert(name.to_string(), id.clone());
        self.top_level_declarations
            .insert(name.to_string(), id.clone());
        self.register_export_alias(&ExportContext::default(), name, &id);
        let file = Resolution::file_id(&self.path);
        Resolution::insert_edge(&mut self.edges, EdgeDraft::new("CONTAINS", &file, &id));
        id
    }

    fn add_test(&mut self, name: &str) -> String {
        let id = format!("test:{}#{name}", self.path);
        self.nodes
            .entry(id.clone())
            .or_insert_with(|| GraphFactNode {
                id: id.clone(),
                kind: "Test".to_string(),
                path: Some(self.path.clone()),
                name: Some(name.to_string()),
                attributes: None,
            });
        let file = Resolution::file_id(&self.path);
        Resolution::insert_edge(&mut self.edges, EdgeDraft::new("CONTAINS", &file, &id));
        id
    }

    fn with_context(&mut self, context: String, visit: impl FnOnce(&mut Self)) {
        let previous = self.current_context.replace(context);
        let previous_export = self.current_export.take();
        visit(self);
        self.current_export = previous_export;
        self.current_context = previous;
    }

    fn with_export(&mut self, export: ExportContext, visit: impl FnOnce(&mut Self)) {
        let previous = self.current_export.replace(export);
        visit(self);
        self.current_export = previous;
    }

    fn add_reference(&mut self, name: String) {
        if let Some(from) = &self.current_context {
            self.references.push(ReferenceFact {
                from: from.clone(),
                name,
                is_test: from.starts_with("test:"),
            });
        }
    }

    fn mark_exported(&mut self, local: &str, export: ExportContext) {
        if let Some(id) = self.top_level_declarations.get(local).cloned() {
            if let Some(node) = self.nodes.get_mut(&id) {
                Helpers::apply_export_attributes(node, &export, local);
            }
            if Helpers::registers_default_export_alias(&export, local) {
                self.declarations.insert("default".to_string(), id.clone());
                self.top_level_declarations
                    .insert("default".to_string(), id);
            }
            let id = self.top_level_declarations.get(local).cloned();
            if let Some(id) = id {
                self.register_export_alias(&export, local, &id);
            }
        } else {
            self.pending_exports.insert(local.to_string(), export);
        }
    }

    fn register_export_alias(&mut self, export: &ExportContext, local: &str, id: &str) {
        self.export_aliases
            .insert(export.export_name_for(local), id.to_string());
    }

    fn import_backed_local(&self, local: &str) -> Option<ImportBackedLocal> {
        self.imports.iter().find_map(|import| {
            import
                .bindings
                .iter()
                .find(|binding| binding.local == local)
                .map(|binding| ImportBackedLocal {
                    source: import.specifier.clone(),
                    imported: binding.imported.clone(),
                })
        })
    }

    fn record_file_export(&mut self, export: Value) {
        self.file_exports.push(export);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ImportBackedLocal {
    source: String,
    imported: String,
}

use super::{
    set_node_attribute, EdgeDraft, FactResolution, FileFacts, HeritageFact, ImportBinding,
    ImportFact, ReExportFact, ReferenceFact, Resolution,
};
use crate::protocol::{GraphFactEdge, GraphFactNode};
use quote::ToTokens;
use serde_json::{json, Value};
use std::collections::{btree_map::Entry, BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{
    Attribute, ExprCall, ExprMacro, ExprMethodCall, File, ImplItem, Item, ItemConst, ItemEnum,
    ItemFn, ItemImpl, ItemMacro, ItemMod, ItemStatic, ItemStruct, ItemTrait, ItemType,
    Path as SynPath, Type, UseTree, Visibility,
};

mod imports;
mod references;
mod syntax;

use imports::{Imports, RustImports};
use references::{References, RustReferences};
use syntax::{ModuleScope, RustSyntax, Syntax};

type ImportResolution = super::super::tsconfig::ImportResolution;

pub(super) fn collect_file_facts(
    path: String,
    file_node: GraphFactNode,
    syntax: &File,
) -> FileFacts {
    let mut collector = RustFileFactCollector::new(path, file_node);
    collector.visit_items(&syntax.items);
    collector.finish()
}

pub(super) fn resolve_import(
    specifier: &str,
    from_path: &str,
    known_files: &BTreeSet<String>,
) -> ImportResolution {
    ImportResolution {
        resolved_path: Imports::resolve_rust_import_path(specifier, from_path, known_files),
        diagnostics: Vec::new(),
    }
}

struct RustFileFactCollector {
    path: String,
    file_node: GraphFactNode,
    nodes: BTreeMap<String, GraphFactNode>,
    edges: BTreeMap<String, GraphFactEdge>,
    declarations: BTreeMap<String, String>,
    export_aliases: BTreeMap<String, String>,
    imports: Vec<ImportFact>,
    references: Vec<ReferenceFact>,
    heritage: Vec<HeritageFact>,
    file_exports: Vec<Value>,
    current_parent: String,
    module_stack: Vec<String>,
    test_module_depth: usize,
}

struct ItemNodeDraft<'a> {
    prefix: &'a str,
    kind: &'a str,
    name: &'a str,
    visibility: &'a Visibility,
    signature: String,
    span: proc_macro2::Span,
}

struct NamedNodeDraft<'a> {
    prefix: &'a str,
    kind: &'a str,
    name: &'a str,
    exported: bool,
    signature: String,
    span: proc_macro2::Span,
}

struct GraphNodeDraft<'a> {
    id: String,
    kind: &'a str,
    name: &'a str,
    attributes: Value,
    exported: bool,
}

impl RustFileFactCollector {
    fn new(path: String, file_node: GraphFactNode) -> Self {
        let module_name = Imports::file_module_name(&path);
        let module_id = format!("module:{path}#{module_name}");
        let mut nodes = BTreeMap::new();
        nodes.insert(
            module_id.clone(),
            GraphFactNode {
                id: module_id.clone(),
                kind: "Module".to_string(),
                path: Some(path.clone()),
                name: Some(module_name.clone()),
                attributes: Some(json!({
                    "language": "rust",
                    "qualifiedName": module_name,
                    "exported": module_name == "crate"
                })),
            },
        );
        let mut edges = BTreeMap::new();
        Resolution::insert_edge(
            &mut edges,
            EdgeDraft::new("CONTAINS", &Resolution::file_id(&path), &module_id),
        );
        Self {
            path,
            file_node,
            nodes,
            edges,
            declarations: BTreeMap::new(),
            export_aliases: BTreeMap::new(),
            imports: Vec::new(),
            references: Vec::new(),
            heritage: Vec::new(),
            file_exports: Vec::new(),
            current_parent: module_id,
            module_stack: vec![module_name],
            test_module_depth: 0,
        }
    }

    fn finish(mut self) -> FileFacts {
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
            re_exports: Vec::<ReExportFact>::new(),
            imports: self.imports,
            references: self.references,
            heritage: self.heritage,
        }
    }

    fn visit_items(&mut self, items: &[Item]) {
        for item in items {
            self.visit_item(item);
        }
    }

    fn visit_item(&mut self, item: &Item) {
        match item {
            Item::Use(item) => self
                .imports
                .extend(Imports::imports_from_use_tree(&item.tree)),
            Item::Mod(item) => self.visit_module(item),
            Item::Struct(item) => self.visit_struct(item),
            Item::Enum(item) => self.visit_enum(item),
            Item::Trait(item) => self.visit_trait(item),
            _ => self.visit_remaining_item(item),
        }
    }

    fn visit_remaining_item(&mut self, item: &Item) {
        match item {
            Item::Impl(item) => self.visit_impl(item),
            Item::Fn(item) => self.visit_function(item),
            Item::Type(item) => self.visit_type_alias(item),
            Item::Const(item) => self.visit_const(item),
            Item::Static(item) => self.visit_static(item),
            Item::Macro(item) => self.visit_macro(item),
            _ => {}
        }
    }

    fn visit_module(&mut self, item: &ItemMod) {
        let name = item.ident.to_string();
        let exported = Syntax::is_exported(&item.vis);
        let is_test = Syntax::has_cfg_test(&item.attrs) || self.test_module_depth > 0;
        let qualified_name = self.module_child_name(&name);
        let id = format!("module:{}#{qualified_name}", self.path);
        let mut attributes = Syntax::base_attributes(
            exported,
            &qualified_name,
            Some(Syntax::signature_for_module(item)),
            Some(item.span()),
        );
        Syntax::attributes_object(&mut attributes)
            .insert("isTest".to_string(), Value::Bool(is_test));
        self.insert_node(GraphNodeDraft {
            id: id.clone(),
            kind: "Module",
            name: &name,
            attributes,
            exported,
        });
        self.with_module(
            ModuleScope {
                parent: id,
                name,
                is_test,
            },
            |collector| {
                if let Some((_, items)) = &item.content {
                    collector.visit_items(items);
                }
            },
        );
    }

    fn visit_struct(&mut self, item: &ItemStruct) {
        self.add_item_node(ItemNodeDraft {
            prefix: "struct",
            kind: "Struct",
            name: &item.ident.to_string(),
            visibility: &item.vis,
            signature: Syntax::signature_for_item(item),
            span: item.span(),
        });
    }

    fn visit_enum(&mut self, item: &ItemEnum) {
        self.add_item_node(ItemNodeDraft {
            prefix: "enum",
            kind: "Enum",
            name: &item.ident.to_string(),
            visibility: &item.vis,
            signature: Syntax::signature_for_item(item),
            span: item.span(),
        });
    }

    fn visit_trait(&mut self, item: &ItemTrait) {
        self.add_item_node(ItemNodeDraft {
            prefix: "trait",
            kind: "Trait",
            name: &item.ident.to_string(),
            visibility: &item.vis,
            signature: Syntax::signature_for_item(item),
            span: item.span(),
        });
    }

    fn visit_impl(&mut self, item: &ItemImpl) {
        let self_type = Syntax::type_name(&item.self_ty).unwrap_or_else(|| "Self".to_string());
        let trait_name = item
            .trait_
            .as_ref()
            .and_then(|(_, path, _)| Syntax::path_last_segment(path));
        let name = Syntax::impl_name(trait_name.as_deref(), &self_type);
        let id = format!("impl:{}#{name}", self.path);
        let attributes =
            Syntax::base_attributes(false, &name, Some(name.clone()), Some(item.span()));
        self.insert_node(GraphNodeDraft {
            id: id.clone(),
            kind: "Impl",
            name: &name,
            attributes,
            exported: false,
        });
        if let Some(trait_name) = trait_name {
            self.heritage.push(HeritageFact {
                from: id.clone(),
                name: trait_name,
                kind: "IMPLEMENTS".to_string(),
            });
        }
        let previous_parent = std::mem::replace(&mut self.current_parent, id);
        for impl_item in &item.items {
            if let ImplItem::Fn(method) = impl_item {
                let name = method.sig.ident.to_string();
                let qualified_name = format!("{self_type}::{name}");
                let id = format!("method:{}#{qualified_name}", self.path);
                let exported = Syntax::is_exported(&method.vis);
                let attributes = Syntax::base_attributes(
                    exported,
                    &qualified_name,
                    Some(Syntax::signature_for_method(method)),
                    Some(method.span()),
                );
                self.insert_node(GraphNodeDraft {
                    id: id.clone(),
                    kind: "Method",
                    name: &name,
                    attributes,
                    exported,
                });
                self.collect_references_from_block(&id, &method.block, false);
            }
        }
        self.current_parent = previous_parent;
    }

    fn visit_function(&mut self, item: &ItemFn) {
        let name = item.sig.ident.to_string();
        let is_test = Syntax::has_test_attr(&item.attrs) || Syntax::has_cfg_test(&item.attrs);
        let qualified_name = self.item_qualified_name(&name);
        let prefix = if is_test { "test" } else { "function" };
        let kind = if is_test { "Test" } else { "Function" };
        let id = format!("{prefix}:{}#{qualified_name}", self.path);
        let exported = Syntax::is_exported(&item.vis);
        let mut attributes = Syntax::base_attributes(
            exported,
            &qualified_name,
            Some(Syntax::signature_for_function(item)),
            Some(item.span()),
        );
        Syntax::attributes_object(&mut attributes)
            .insert("isTest".to_string(), Value::Bool(is_test));
        self.insert_node(GraphNodeDraft {
            id: id.clone(),
            kind,
            name: &name,
            attributes,
            exported,
        });
        self.collect_references_from_block(&id, &item.block, is_test);
    }

    fn visit_type_alias(&mut self, item: &ItemType) {
        self.add_item_node(ItemNodeDraft {
            prefix: "type",
            kind: "TypeAlias",
            name: &item.ident.to_string(),
            visibility: &item.vis,
            signature: Syntax::signature_for_item(item),
            span: item.span(),
        });
    }

    fn visit_const(&mut self, item: &ItemConst) {
        self.add_item_node(ItemNodeDraft {
            prefix: "const",
            kind: "Const",
            name: &item.ident.to_string(),
            visibility: &item.vis,
            signature: Syntax::signature_for_item(item),
            span: item.span(),
        });
    }

    fn visit_static(&mut self, item: &ItemStatic) {
        self.add_item_node(ItemNodeDraft {
            prefix: "static",
            kind: "Static",
            name: &item.ident.to_string(),
            visibility: &item.vis,
            signature: Syntax::signature_for_item(item),
            span: item.span(),
        });
    }

    fn visit_macro(&mut self, item: &ItemMacro) {
        let Some(name) = item
            .mac
            .path
            .segments
            .last()
            .map(|segment| segment.ident.to_string())
        else {
            return;
        };
        if name != "macro_rules" {
            return;
        }
        let Some(ident) = item.ident.as_ref() else {
            return;
        };
        let macro_name = ident.to_string();
        self.add_named_node(NamedNodeDraft {
            prefix: "macro",
            kind: "Macro",
            name: &macro_name,
            exported: false,
            signature: Syntax::signature_for_item(item),
            span: item.span(),
        });
    }

    fn add_item_node(&mut self, draft: ItemNodeDraft<'_>) -> String {
        self.add_named_node(NamedNodeDraft {
            prefix: draft.prefix,
            kind: draft.kind,
            name: draft.name,
            exported: Syntax::is_exported(draft.visibility),
            signature: draft.signature,
            span: draft.span,
        })
    }

    fn add_named_node(&mut self, draft: NamedNodeDraft<'_>) -> String {
        let qualified_name = self.item_qualified_name(draft.name);
        let id = format!("{}:{}#{qualified_name}", draft.prefix, self.path);
        let attributes = Syntax::base_attributes(
            draft.exported,
            &qualified_name,
            Some(draft.signature),
            Some(draft.span),
        );
        self.insert_node(GraphNodeDraft {
            id: id.clone(),
            kind: draft.kind,
            name: draft.name,
            attributes,
            exported: draft.exported,
        });
        id
    }

    fn insert_node(&mut self, draft: GraphNodeDraft<'_>) {
        match self.nodes.entry(draft.id.clone()) {
            Entry::Occupied(mut entry) => {
                entry.get_mut().attributes = Some(draft.attributes);
            }
            Entry::Vacant(entry) => {
                entry.insert(GraphFactNode {
                    id: draft.id.clone(),
                    kind: draft.kind.to_string(),
                    path: Some(self.path.clone()),
                    name: Some(draft.name.to_string()),
                    attributes: Some(draft.attributes),
                });
            }
        }
        self.declarations
            .insert(draft.name.to_string(), draft.id.clone());
        if let Some(qualified_name) = draft.id.split_once('#').map(|(_, name)| name.to_string()) {
            self.declarations
                .insert(qualified_name.clone(), draft.id.clone());
            if draft.exported {
                self.export_aliases
                    .insert(draft.name.to_string(), draft.id.clone());
                self.export_aliases.insert(qualified_name, draft.id.clone());
                self.file_exports.push(json!({
                    "kind": "named",
                    "local": draft.name,
                    "exported": draft.name,
                    "source": null,
                    "supportedSymbol": true,
                    "policy": "pub"
                }));
            }
        }
        Resolution::insert_edge(
            &mut self.edges,
            EdgeDraft::new("CONTAINS", &self.current_parent, &draft.id),
        );
    }

    fn collect_references_from_block(&mut self, from: &str, block: &syn::Block, is_test: bool) {
        self.references
            .extend(References::collect(from.to_string(), block, is_test));
    }

    fn with_module(&mut self, scope: ModuleScope, visit: impl FnOnce(&mut Self)) {
        let previous_parent = std::mem::replace(&mut self.current_parent, scope.parent);
        self.module_stack.push(scope.name);
        if scope.is_test {
            self.test_module_depth += 1;
        }
        visit(self);
        if scope.is_test {
            self.test_module_depth = self.test_module_depth.saturating_sub(1);
        }
        self.module_stack.pop();
        self.current_parent = previous_parent;
    }

    fn module_child_name(&self, name: &str) -> String {
        let mut parts = self.module_stack.clone();
        if parts.first().is_some_and(|part| part == "crate") {
            parts.clear();
        }
        parts.push(name.to_string());
        parts.join(".")
    }

    fn item_qualified_name(&self, name: &str) -> String {
        let mut parts = self.module_stack.clone();
        if parts.first().is_some_and(|part| part == "crate") {
            parts.clear();
        }
        if parts.is_empty() {
            return name.to_string();
        }
        format!("{}::{name}", parts.join("."))
    }
}

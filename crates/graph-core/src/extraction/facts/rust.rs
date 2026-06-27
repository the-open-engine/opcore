use super::{
    file_id, insert_edge, EdgeDraft, FileFacts, HeritageFact, ImportBinding, ImportFact,
    ReExportFact, ReferenceFact,
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
        resolved_path: resolve_rust_import_path(specifier, from_path, known_files),
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

impl RustFileFactCollector {
    fn new(path: String, file_node: GraphFactNode) -> Self {
        let module_name = file_module_name(&path);
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
        insert_edge(
            &mut edges,
            EdgeDraft::new("CONTAINS", &file_id(&path), &module_id),
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
            set_attribute(
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
            Item::Use(item) => self.imports.extend(imports_from_use_tree(&item.tree)),
            Item::Mod(item) => self.visit_module(item),
            Item::Struct(item) => self.visit_struct(item),
            Item::Enum(item) => self.visit_enum(item),
            Item::Trait(item) => self.visit_trait(item),
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
        let exported = is_exported(&item.vis);
        let is_test = has_cfg_test(&item.attrs) || self.test_module_depth > 0;
        let qualified_name = self.module_child_name(&name);
        let id = format!("module:{}#{qualified_name}", self.path);
        let mut attributes = base_attributes(
            exported,
            &qualified_name,
            Some(signature_for_module(item)),
            Some(item.span()),
        );
        attributes_object(&mut attributes).insert("isTest".to_string(), Value::Bool(is_test));
        self.insert_node(&id, "Module", &name, attributes, exported);
        self.with_module(id, name, is_test, |collector| {
            if let Some((_, items)) = &item.content {
                collector.visit_items(items);
            }
        });
    }

    fn visit_struct(&mut self, item: &ItemStruct) {
        self.add_item_node(
            "struct",
            "Struct",
            &item.ident.to_string(),
            &item.vis,
            signature_for_item(item),
            item.span(),
        );
    }

    fn visit_enum(&mut self, item: &ItemEnum) {
        self.add_item_node(
            "enum",
            "Enum",
            &item.ident.to_string(),
            &item.vis,
            signature_for_item(item),
            item.span(),
        );
    }

    fn visit_trait(&mut self, item: &ItemTrait) {
        self.add_item_node(
            "trait",
            "Trait",
            &item.ident.to_string(),
            &item.vis,
            signature_for_item(item),
            item.span(),
        );
    }

    fn visit_impl(&mut self, item: &ItemImpl) {
        let self_type = type_name(&item.self_ty).unwrap_or_else(|| "Self".to_string());
        let trait_name = item
            .trait_
            .as_ref()
            .and_then(|(_, path, _)| path_last_segment(path));
        let name = impl_name(trait_name.as_deref(), &self_type);
        let id = format!("impl:{}#{name}", self.path);
        let attributes = base_attributes(false, &name, Some(name.clone()), Some(item.span()));
        self.insert_node(&id, "Impl", &name, attributes, false);
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
                let exported = is_exported(&method.vis);
                let attributes = base_attributes(
                    exported,
                    &qualified_name,
                    Some(signature_for_method(method)),
                    Some(method.span()),
                );
                self.insert_node(&id, "Method", &name, attributes, exported);
                self.collect_references_from_block(&id, &method.block, false);
            }
        }
        self.current_parent = previous_parent;
    }

    fn visit_function(&mut self, item: &ItemFn) {
        let name = item.sig.ident.to_string();
        let is_test = has_test_attr(&item.attrs) || has_cfg_test(&item.attrs);
        let qualified_name = self.item_qualified_name(&name);
        let prefix = if is_test { "test" } else { "function" };
        let kind = if is_test { "Test" } else { "Function" };
        let id = format!("{prefix}:{}#{qualified_name}", self.path);
        let exported = is_exported(&item.vis);
        let mut attributes = base_attributes(
            exported,
            &qualified_name,
            Some(signature_for_function(item)),
            Some(item.span()),
        );
        attributes_object(&mut attributes).insert("isTest".to_string(), Value::Bool(is_test));
        self.insert_node(&id, kind, &name, attributes, exported);
        self.collect_references_from_block(&id, &item.block, is_test);
    }

    fn visit_type_alias(&mut self, item: &ItemType) {
        self.add_item_node(
            "type",
            "TypeAlias",
            &item.ident.to_string(),
            &item.vis,
            signature_for_item(item),
            item.span(),
        );
    }

    fn visit_const(&mut self, item: &ItemConst) {
        self.add_item_node(
            "const",
            "Const",
            &item.ident.to_string(),
            &item.vis,
            signature_for_item(item),
            item.span(),
        );
    }

    fn visit_static(&mut self, item: &ItemStatic) {
        self.add_item_node(
            "static",
            "Static",
            &item.ident.to_string(),
            &item.vis,
            signature_for_item(item),
            item.span(),
        );
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
        self.add_named_node(
            "macro",
            "Macro",
            &macro_name,
            false,
            signature_for_item(item),
            item.span(),
        );
    }

    fn add_item_node(
        &mut self,
        prefix: &str,
        kind: &str,
        name: &str,
        visibility: &Visibility,
        signature: String,
        span: proc_macro2::Span,
    ) -> String {
        self.add_named_node(prefix, kind, name, is_exported(visibility), signature, span)
    }

    fn add_named_node(
        &mut self,
        prefix: &str,
        kind: &str,
        name: &str,
        exported: bool,
        signature: String,
        span: proc_macro2::Span,
    ) -> String {
        let qualified_name = self.item_qualified_name(name);
        let id = format!("{prefix}:{}#{qualified_name}", self.path);
        let attributes = base_attributes(exported, &qualified_name, Some(signature), Some(span));
        self.insert_node(&id, kind, name, attributes, exported);
        id
    }

    fn insert_node(&mut self, id: &str, kind: &str, name: &str, attributes: Value, exported: bool) {
        match self.nodes.entry(id.to_string()) {
            Entry::Occupied(mut entry) => {
                entry.get_mut().attributes = Some(attributes);
            }
            Entry::Vacant(entry) => {
                entry.insert(GraphFactNode {
                    id: id.to_string(),
                    kind: kind.to_string(),
                    path: Some(self.path.clone()),
                    name: Some(name.to_string()),
                    attributes: Some(attributes),
                });
            }
        }
        self.declarations.insert(name.to_string(), id.to_string());
        if let Some(qualified_name) = id.split_once('#').map(|(_, name)| name.to_string()) {
            self.declarations
                .insert(qualified_name.clone(), id.to_string());
            if exported {
                self.export_aliases.insert(name.to_string(), id.to_string());
                self.export_aliases.insert(qualified_name, id.to_string());
                self.file_exports.push(json!({
                    "kind": "named",
                    "local": name,
                    "exported": name,
                    "source": null,
                    "supportedSymbol": true,
                    "policy": "pub"
                }));
            }
        }
        insert_edge(
            &mut self.edges,
            EdgeDraft::new("CONTAINS", &self.current_parent, id),
        );
    }

    fn collect_references_from_block(&mut self, from: &str, block: &syn::Block, is_test: bool) {
        let mut visitor = RustReferenceVisitor::new(from.to_string(), is_test);
        visitor.visit_block(block);
        self.references.extend(visitor.references);
    }

    fn with_module(
        &mut self,
        parent: String,
        name: String,
        is_test: bool,
        visit: impl FnOnce(&mut Self),
    ) {
        let previous_parent = std::mem::replace(&mut self.current_parent, parent);
        self.module_stack.push(name);
        if is_test {
            self.test_module_depth += 1;
        }
        visit(self);
        if is_test {
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

struct RustReferenceVisitor {
    from: String,
    is_test: bool,
    references: Vec<ReferenceFact>,
}

impl RustReferenceVisitor {
    fn new(from: String, is_test: bool) -> Self {
        Self {
            from,
            is_test,
            references: Vec::new(),
        }
    }

    fn push_path_reference(&mut self, path: &SynPath) {
        if let Some(name) = reference_name_for_path(path) {
            self.references.push(ReferenceFact {
                from: self.from.clone(),
                name,
                is_test: self.is_test,
            });
        }
    }
}

impl<'ast> Visit<'ast> for RustReferenceVisitor {
    fn visit_expr_call(&mut self, node: &'ast ExprCall) {
        if let syn::Expr::Path(path) = node.func.as_ref() {
            self.push_path_reference(&path.path);
        }
        visit::visit_expr_call(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        self.references.push(ReferenceFact {
            from: self.from.clone(),
            name: node.method.to_string(),
            is_test: self.is_test,
        });
        visit::visit_expr_method_call(self, node);
    }

    fn visit_expr_macro(&mut self, node: &'ast ExprMacro) {
        self.push_path_reference(&node.mac.path);
        visit::visit_expr_macro(self, node);
    }
}

fn imports_from_use_tree(tree: &UseTree) -> Vec<ImportFact> {
    let mut imports = Vec::new();
    collect_use_tree(tree, Vec::new(), &mut imports);
    imports
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
        .map(path_to_string)
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
    let file_candidate = format!("{}.rs", path_to_string(&module_path));
    let mut mod_candidate = module_path;
    mod_candidate.push("mod.rs");
    vec![file_candidate, path_to_string(&mod_candidate)]
}

fn crate_root_file_for(from_path: &str, known_files: &BTreeSet<String>) -> Option<String> {
    let source_dir = crate_source_dir_for(from_path, known_files)?;
    crate_root_file_in_source_dir(&source_dir, known_files)
}

fn crate_source_dir_for(from_path: &str, known_files: &BTreeSet<String>) -> Option<String> {
    let mut current = Path::new(from_path).parent();
    while let Some(directory) = current {
        let source_dir = path_to_string(directory);
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
    let parent = path.parent().map(path_to_string).unwrap_or_default();
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
        .map(path_to_string)
}

fn join_path(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_string()
    } else {
        format!("{parent}/{child}")
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

fn is_exported(visibility: &Visibility) -> bool {
    !matches!(visibility, Visibility::Inherited)
}

fn has_test_attr(attributes: &[Attribute]) -> bool {
    attributes
        .iter()
        .any(|attribute| attribute.path().is_ident("test"))
}

fn has_cfg_test(attributes: &[Attribute]) -> bool {
    attributes.iter().any(|attribute| {
        attribute.path().is_ident("cfg")
            && attribute
                .meta
                .to_token_stream()
                .to_string()
                .contains("test")
    })
}

fn signature_for_module(item: &ItemMod) -> String {
    format!("{}mod {}", visibility_tokens(&item.vis), item.ident)
        .trim()
        .to_string()
}

fn signature_for_function(item: &ItemFn) -> String {
    format!(
        "{}{}",
        visibility_tokens(&item.vis),
        item.sig.to_token_stream()
    )
    .trim()
    .to_string()
}

fn signature_for_method(item: &syn::ImplItemFn) -> String {
    format!(
        "{}{}",
        visibility_tokens(&item.vis),
        item.sig.to_token_stream()
    )
    .trim()
    .to_string()
}

fn signature_for_item(item: &impl ToTokens) -> String {
    item.to_token_stream().to_string()
}

fn visibility_tokens(visibility: &Visibility) -> String {
    let tokens = visibility.to_token_stream().to_string();
    if tokens.is_empty() {
        tokens
    } else {
        format!("{tokens} ")
    }
}

fn type_name(ty: &Type) -> Option<String> {
    match ty {
        Type::Path(path) => path_last_segment(&path.path),
        _ => None,
    }
}

fn path_last_segment(path: &SynPath) -> Option<String> {
    path.segments
        .last()
        .map(|segment| segment.ident.to_string())
}

fn impl_name(trait_name: Option<&str>, self_type: &str) -> String {
    match trait_name {
        Some(trait_name) => format!("impl {trait_name} for {self_type}"),
        None => format!("impl {self_type}"),
    }
}

fn reference_name_for_path(path: &SynPath) -> Option<String> {
    let parts = path
        .segments
        .iter()
        .map(|segment| segment.ident.to_string())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return None;
    }
    if parts
        .iter()
        .any(|part| part == "self" || part == "Self" || part == "super" || part == "crate")
    {
        return None;
    }
    let separator = if parts.len() > 1 { "." } else { "" };
    if separator.is_empty() {
        parts.first().cloned()
    } else {
        Some(parts.join(separator))
    }
}

fn base_attributes(
    exported: bool,
    qualified_name: &str,
    signature: Option<String>,
    span: Option<proc_macro2::Span>,
) -> Value {
    let mut attributes = serde_json::Map::new();
    attributes.insert("language".to_string(), Value::String("rust".to_string()));
    attributes.insert("exported".to_string(), Value::Bool(exported));
    attributes.insert(
        "qualifiedName".to_string(),
        Value::String(qualified_name.to_string()),
    );
    if exported {
        attributes.insert("exportKind".to_string(), Value::String("named".to_string()));
        attributes.insert(
            "exportName".to_string(),
            Value::String(qualified_name.to_string()),
        );
    }
    if let Some(signature) = signature {
        attributes.insert("signature".to_string(), Value::String(signature));
    }
    if let Some(span) = span {
        let start = span.start();
        let end = span.end();
        attributes.insert("lineStart".to_string(), json!(start.line));
        attributes.insert("lineEnd".to_string(), json!(end.line));
        attributes.insert("columnStart".to_string(), json!(start.column));
        attributes.insert("columnEnd".to_string(), json!(end.column));
    }
    Value::Object(attributes)
}

fn set_attribute(node: &mut GraphFactNode, key: &str, value: Value) {
    attributes_object(
        node.attributes
            .get_or_insert_with(|| Value::Object(serde_json::Map::new())),
    )
    .insert(key.to_string(), value);
}

fn attributes_object(value: &mut Value) -> &mut serde_json::Map<String, Value> {
    loop {
        if let Value::Object(object) = value {
            return object;
        }
        *value = Value::Object(serde_json::Map::new());
    }
}

fn path_to_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().replace('\\', "/")
}

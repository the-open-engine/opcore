use super::manifest::RustManifest;
use crate::extraction::facts::{
    file_id, insert_edge, EdgeDraft, FileFacts, HeritageFact, ReferenceFact, RustImportFact,
};
use crate::protocol::{GraphFactEdge, GraphFactNode};
use quote::{quote, ToTokens};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{
    Expr, ExprCall, ExprMethodCall, File, ImplItemFn, ItemConst, ItemEnum, ItemFn, ItemImpl,
    ItemMacro, ItemMod, ItemStatic, ItemStruct, ItemTrait, ItemType, TraitItemFn, Type, UseTree,
    Visibility,
};

pub fn collect_file_facts(
    path: String,
    file_node: GraphFactNode,
    syntax: &File,
    manifest: &RustManifest,
) -> FileFacts {
    let root_module = manifest.module_path_for_file(&path);
    let mut collector = RustFactCollector::new(path, root_module, manifest);
    collector.add_file_module();
    collector.visit_file(syntax);
    collector.finish(file_node)
}

struct RustFactCollector<'a> {
    path: String,
    root_module: String,
    manifest: &'a RustManifest,
    nodes: BTreeMap<String, GraphFactNode>,
    edges: BTreeMap<String, GraphFactEdge>,
    declarations: BTreeMap<String, String>,
    qualified_declarations: BTreeMap<String, String>,
    rust_imports: Vec<RustImportFact>,
    references: Vec<ReferenceFact>,
    heritage: Vec<HeritageFact>,
    owner_stack: Vec<String>,
    module_stack: Vec<String>,
    impl_stack: Vec<ImplContext>,
    trait_stack: Vec<String>,
    current_context: Option<String>,
}

#[derive(Debug, Clone)]
struct ImplContext {
    self_qualified: String,
}

struct NodeSpec {
    prefix: &'static str,
    kind: &'static str,
    name: String,
    qualified: String,
    signature: String,
    line_start: usize,
    line_end: usize,
    exported: bool,
    test: bool,
    cfg_test: bool,
}

impl<'a> RustFactCollector<'a> {
    fn new(path: String, root_module: String, manifest: &'a RustManifest) -> Self {
        Self {
            path,
            root_module,
            manifest,
            nodes: BTreeMap::new(),
            edges: BTreeMap::new(),
            declarations: BTreeMap::new(),
            qualified_declarations: BTreeMap::new(),
            rust_imports: Vec::new(),
            references: Vec::new(),
            heritage: Vec::new(),
            owner_stack: Vec::new(),
            module_stack: Vec::new(),
            impl_stack: Vec::new(),
            trait_stack: Vec::new(),
            current_context: None,
        }
    }

    fn add_file_module(&mut self) {
        let spec = NodeSpec {
            prefix: "module",
            kind: "Module",
            name: last_path_segment(&self.root_module),
            qualified: self.root_module.clone(),
            signature: format!("mod {}", self.root_module),
            line_start: 1,
            line_end: 1,
            exported: false,
            test: false,
            cfg_test: false,
        };
        let module_id = self.add_node(spec);
        let file = file_id(&self.path);
        insert_edge(
            &mut self.edges,
            EdgeDraft::new("CONTAINS", &file, &module_id),
        );
        self.owner_stack.push(module_id);
        self.module_stack.push(self.root_module.clone());
    }

    fn finish(self, file_node: GraphFactNode) -> FileFacts {
        let rust_package_root = Some(self.manifest.package_root_for_path(&self.path));
        FileFacts {
            path: self.path,
            file_node,
            nodes: self.nodes,
            edges: self.edges,
            declarations: self.declarations,
            qualified_declarations: self.qualified_declarations,
            rust_package_root,
            export_aliases: BTreeMap::new(),
            re_exports: Vec::new(),
            imports: Vec::new(),
            rust_imports: self.rust_imports,
            references: self.references,
            heritage: self.heritage,
        }
    }

    fn add_node(&mut self, spec: NodeSpec) -> String {
        let id = format!("{}:{}#{}", spec.prefix, self.path, spec.qualified);
        let attributes = rust_attributes(&spec);
        self.nodes
            .entry(id.clone())
            .or_insert_with(|| GraphFactNode {
                id: id.clone(),
                kind: spec.kind.to_string(),
                path: Some(self.path.clone()),
                name: Some(spec.name.clone()),
                attributes: Some(Value::Object(attributes)),
            });
        self.declarations.insert(spec.name, id.clone());
        self.qualified_declarations
            .insert(spec.qualified, id.clone());
        id
    }

    fn add_owned_node(&mut self, spec: NodeSpec) -> String {
        let id = self.add_node(spec);
        let owner = self.current_owner();
        insert_edge(&mut self.edges, EdgeDraft::new("CONTAINS", &owner, &id));
        id
    }

    fn current_owner(&self) -> String {
        self.owner_stack
            .last()
            .cloned()
            .unwrap_or_else(|| file_id(&self.path))
    }

    fn current_module(&self) -> String {
        self.module_stack
            .last()
            .cloned()
            .unwrap_or_else(|| self.root_module.clone())
    }

    fn qualify_in_current_module(&self, name: &str) -> String {
        format!("{}::{name}", self.current_module())
    }

    fn qualify_method(&self, name: &str) -> String {
        self.impl_stack
            .last()
            .map(|context| format!("{}::{name}", context.self_qualified))
            .unwrap_or_else(|| self.qualify_in_current_module(name))
    }

    fn qualify_trait_method(&self, name: &str) -> String {
        self.trait_stack
            .last()
            .map(|trait_qualified| format!("{trait_qualified}::{name}"))
            .unwrap_or_else(|| self.qualify_in_current_module(name))
    }

    fn push_owner(&mut self, owner: String, visit: impl FnOnce(&mut Self)) {
        self.owner_stack.push(owner);
        visit(self);
        self.owner_stack.pop();
    }

    fn push_module(&mut self, module: String, owner: String, visit: impl FnOnce(&mut Self)) {
        self.module_stack.push(module);
        self.push_owner(owner, visit);
        self.module_stack.pop();
    }

    fn push_impl(&mut self, context: ImplContext, owner: String, visit: impl FnOnce(&mut Self)) {
        self.impl_stack.push(context);
        self.push_owner(owner, visit);
        self.impl_stack.pop();
    }

    fn push_trait(&mut self, qualified: String, owner: String, visit: impl FnOnce(&mut Self)) {
        self.trait_stack.push(qualified);
        self.push_owner(owner, visit);
        self.trait_stack.pop();
    }

    fn with_context(&mut self, context: String, visit: impl FnOnce(&mut Self)) {
        let previous = self.current_context.replace(context);
        visit(self);
        self.current_context = previous;
    }

    fn add_reference(&mut self, name: String) {
        if let Some(from) = &self.current_context {
            self.references.push(ReferenceFact {
                from: from.clone(),
                name,
            });
        }
    }

    fn add_use_tree(&mut self, tree: &UseTree) {
        self.collect_use_tree(Vec::new(), tree);
    }

    fn collect_use_tree(&mut self, prefix: Vec<String>, tree: &UseTree) {
        match tree {
            UseTree::Path(path) => {
                let mut next = prefix;
                next.push(path.ident.to_string());
                self.collect_use_tree(next, &path.tree);
            }
            UseTree::Name(name) => {
                let target = use_leaf_target(prefix, &name.ident.to_string());
                self.add_rust_import(target, None);
            }
            UseTree::Rename(rename) => {
                let target = use_leaf_target(prefix, &rename.ident.to_string());
                self.add_rust_import(target, Some(rename.rename.to_string()));
            }
            UseTree::Glob(_) => {
                self.add_rust_import(prefix, None);
            }
            UseTree::Group(group) => {
                for item in &group.items {
                    self.collect_use_tree(prefix.clone(), item);
                }
            }
        }
    }

    fn add_rust_import(&mut self, segments: Vec<String>, local: Option<String>) {
        let Some((target, dependency)) =
            canonical_use_target(segments, &self.current_module(), self.manifest, &self.path)
        else {
            return;
        };
        self.rust_imports.push(RustImportFact {
            target,
            local,
            dependency,
        });
    }
}

impl<'ast> Visit<'ast> for RustFactCollector<'_> {
    fn visit_item_mod(&mut self, item: &'ast ItemMod) {
        let name = item.ident.to_string();
        let qualified = self.qualify_in_current_module(&name);
        let span = line_span(item);
        let spec = NodeSpec {
            prefix: "module",
            kind: "Module",
            name,
            qualified: qualified.clone(),
            signature: normalize_tokens(quote!(#item).to_string()),
            line_start: span.0,
            line_end: span.1,
            exported: is_exported(&item.vis),
            test: has_test_attr(&item.attrs),
            cfg_test: has_cfg_test_attr(&item.attrs),
        };
        let id = self.add_owned_node(spec);
        if let Some((_, items)) = &item.content {
            self.push_module(qualified, id, |collector| {
                for item in items {
                    collector.visit_item(item);
                }
            });
        } else {
            self.qualified_declarations.remove(&qualified);
        }
    }

    fn visit_item_struct(&mut self, item: &'ast ItemStruct) {
        let name = item.ident.to_string();
        let qualified = self.qualify_in_current_module(&name);
        let span = line_span(item);
        let vis = &item.vis;
        let ident = &item.ident;
        let generics = &item.generics;
        self.add_owned_node(NodeSpec {
            prefix: "struct",
            kind: "Struct",
            name,
            qualified,
            signature: normalize_tokens(quote!(#vis struct #ident #generics).to_string()),
            line_start: span.0,
            line_end: span.1,
            exported: is_exported(&item.vis),
            test: has_test_attr(&item.attrs),
            cfg_test: has_cfg_test_attr(&item.attrs),
        });
    }

    fn visit_item_enum(&mut self, item: &'ast ItemEnum) {
        let name = item.ident.to_string();
        let qualified = self.qualify_in_current_module(&name);
        let span = line_span(item);
        let vis = &item.vis;
        let ident = &item.ident;
        let generics = &item.generics;
        self.add_owned_node(NodeSpec {
            prefix: "enum",
            kind: "Enum",
            name,
            qualified,
            signature: normalize_tokens(quote!(#vis enum #ident #generics).to_string()),
            line_start: span.0,
            line_end: span.1,
            exported: is_exported(&item.vis),
            test: has_test_attr(&item.attrs),
            cfg_test: has_cfg_test_attr(&item.attrs),
        });
    }

    fn visit_item_trait(&mut self, item: &'ast ItemTrait) {
        let name = item.ident.to_string();
        let qualified = self.qualify_in_current_module(&name);
        let span = line_span(item);
        let vis = &item.vis;
        let ident = &item.ident;
        let generics = &item.generics;
        let id = self.add_owned_node(NodeSpec {
            prefix: "trait",
            kind: "Trait",
            name,
            qualified: qualified.clone(),
            signature: normalize_tokens(quote!(#vis trait #ident #generics).to_string()),
            line_start: span.0,
            line_end: span.1,
            exported: is_exported(&item.vis),
            test: has_test_attr(&item.attrs),
            cfg_test: has_cfg_test_attr(&item.attrs),
        });
        self.push_trait(qualified, id, |collector| {
            visit::visit_item_trait(collector, item);
        });
    }

    fn visit_item_impl(&mut self, item: &'ast ItemImpl) {
        let self_name = type_name(&item.self_ty);
        let trait_name = item
            .trait_
            .as_ref()
            .and_then(|(_, path, _)| path_to_string(path));
        let impl_name = trait_name
            .as_ref()
            .map(|trait_name| format!("{trait_name} for {self_name}"))
            .unwrap_or_else(|| self_name.clone());
        let qualified_self = qualify_type_name(&self.current_module(), &self_name);
        let qualified = format!(
            "{}::{}",
            self.current_module(),
            sanitize_id_part(&impl_name)
        );
        let span = line_span(item);
        let id = self.add_owned_node(NodeSpec {
            prefix: "impl",
            kind: "Impl",
            name: impl_name,
            qualified,
            signature: normalize_tokens(item.to_token_stream().to_string()),
            line_start: span.0,
            line_end: span.1,
            exported: false,
            test: has_test_attr(&item.attrs),
            cfg_test: has_cfg_test_attr(&item.attrs),
        });
        if let Some(trait_name) = trait_name {
            self.heritage.push(HeritageFact {
                from: id.clone(),
                name: trait_name,
                kind: "IMPLEMENTS".to_string(),
            });
        }
        self.push_impl(
            ImplContext {
                self_qualified: qualified_self,
            },
            id,
            |collector| visit::visit_item_impl(collector, item),
        );
    }

    fn visit_item_fn(&mut self, item: &'ast ItemFn) {
        let name = item.sig.ident.to_string();
        let qualified = self.qualify_in_current_module(&name);
        let span = line_span(item);
        let is_test = has_test_attr(&item.attrs);
        let cfg_test = has_cfg_test_attr(&item.attrs);
        let vis = &item.vis;
        let sig = &item.sig;
        let id = self.add_owned_node(NodeSpec {
            prefix: if is_test || cfg_test {
                "test"
            } else {
                "function"
            },
            kind: if is_test || cfg_test {
                "Test"
            } else {
                "Function"
            },
            name,
            qualified,
            signature: normalize_tokens(quote!(#vis #sig).to_string()),
            line_start: span.0,
            line_end: span.1,
            exported: is_exported(&item.vis),
            test: is_test,
            cfg_test,
        });
        self.with_context(id, |collector| collector.visit_block(&item.block));
    }

    fn visit_impl_item_fn(&mut self, item: &'ast ImplItemFn) {
        let name = item.sig.ident.to_string();
        let qualified = self.qualify_method(&name);
        let span = line_span(item);
        let is_test = has_test_attr(&item.attrs);
        let cfg_test = has_cfg_test_attr(&item.attrs);
        let vis = &item.vis;
        let sig = &item.sig;
        let id = self.add_owned_node(NodeSpec {
            prefix: if is_test || cfg_test {
                "test"
            } else {
                "method"
            },
            kind: if is_test || cfg_test {
                "Test"
            } else {
                "Method"
            },
            name,
            qualified,
            signature: normalize_tokens(quote!(#vis #sig).to_string()),
            line_start: span.0,
            line_end: span.1,
            exported: is_exported(&item.vis),
            test: is_test,
            cfg_test,
        });
        self.with_context(id, |collector| collector.visit_block(&item.block));
    }

    fn visit_trait_item_fn(&mut self, item: &'ast TraitItemFn) {
        let name = item.sig.ident.to_string();
        let qualified = self.qualify_trait_method(&name);
        let span = line_span(item);
        let id = self.add_owned_node(NodeSpec {
            prefix: "method",
            kind: "Method",
            name,
            qualified,
            signature: normalize_tokens(item.sig.to_token_stream().to_string()),
            line_start: span.0,
            line_end: span.1,
            exported: false,
            test: has_test_attr(&item.attrs),
            cfg_test: has_cfg_test_attr(&item.attrs),
        });
        if let Some(default) = &item.default {
            self.with_context(id, |collector| collector.visit_block(default));
        }
    }

    fn visit_item_type(&mut self, item: &'ast ItemType) {
        let name = item.ident.to_string();
        let qualified = self.qualify_in_current_module(&name);
        let span = line_span(item);
        let vis = &item.vis;
        let ident = &item.ident;
        let generics = &item.generics;
        let ty = &item.ty;
        self.add_owned_node(NodeSpec {
            prefix: "type",
            kind: "TypeAlias",
            name,
            qualified,
            signature: normalize_tokens(quote!(#vis type #ident #generics = #ty).to_string()),
            line_start: span.0,
            line_end: span.1,
            exported: is_exported(&item.vis),
            test: has_test_attr(&item.attrs),
            cfg_test: has_cfg_test_attr(&item.attrs),
        });
    }

    fn visit_item_const(&mut self, item: &'ast ItemConst) {
        let name = item.ident.to_string();
        let qualified = self.qualify_in_current_module(&name);
        let span = line_span(item);
        let vis = &item.vis;
        let ident = &item.ident;
        let ty = &item.ty;
        let id = self.add_owned_node(NodeSpec {
            prefix: "const",
            kind: "Const",
            name,
            qualified,
            signature: normalize_tokens(quote!(#vis const #ident : #ty).to_string()),
            line_start: span.0,
            line_end: span.1,
            exported: is_exported(&item.vis),
            test: has_test_attr(&item.attrs),
            cfg_test: has_cfg_test_attr(&item.attrs),
        });
        self.with_context(id, |collector| collector.visit_expr(&item.expr));
    }

    fn visit_item_static(&mut self, item: &'ast ItemStatic) {
        let name = item.ident.to_string();
        let qualified = self.qualify_in_current_module(&name);
        let span = line_span(item);
        let vis = &item.vis;
        let mutability = &item.mutability;
        let ident = &item.ident;
        let ty = &item.ty;
        let id = self.add_owned_node(NodeSpec {
            prefix: "static",
            kind: "Static",
            name,
            qualified,
            signature: normalize_tokens(quote!(#vis static #mutability #ident : #ty).to_string()),
            line_start: span.0,
            line_end: span.1,
            exported: is_exported(&item.vis),
            test: has_test_attr(&item.attrs),
            cfg_test: has_cfg_test_attr(&item.attrs),
        });
        self.with_context(id, |collector| collector.visit_expr(&item.expr));
    }

    fn visit_item_macro(&mut self, item: &'ast ItemMacro) {
        if !item.mac.path.is_ident("macro_rules") {
            visit::visit_item_macro(self, item);
            return;
        }
        let Some(ident) = &item.ident else {
            return;
        };
        let name = ident.to_string();
        let qualified = self.qualify_in_current_module(&name);
        let span = line_span(item);
        self.add_owned_node(NodeSpec {
            prefix: "macro",
            kind: "Macro",
            name,
            qualified,
            signature: normalize_tokens(quote!(macro_rules! #ident).to_string()),
            line_start: span.0,
            line_end: span.1,
            exported: false,
            test: has_test_attr(&item.attrs),
            cfg_test: has_cfg_test_attr(&item.attrs),
        });
    }

    fn visit_item_use(&mut self, item: &'ast syn::ItemUse) {
        self.add_use_tree(&item.tree);
    }

    fn visit_expr_call(&mut self, expression: &'ast ExprCall) {
        if let Expr::Path(path) = expression.func.as_ref() {
            if let Some(name) = path_to_string(&path.path) {
                self.add_reference(name);
            }
        }
        visit::visit_expr_call(self, expression);
    }

    fn visit_expr_method_call(&mut self, expression: &'ast ExprMethodCall) {
        self.add_reference(expression.method.to_string());
        visit::visit_expr_method_call(self, expression);
    }
}

fn rust_attributes(spec: &NodeSpec) -> Map<String, Value> {
    let mut attributes = Map::new();
    attributes.insert("language".to_string(), Value::String("rust".to_string()));
    attributes.insert("exported".to_string(), Value::Bool(spec.exported));
    attributes.insert(
        "qualifiedName".to_string(),
        Value::String(spec.qualified.clone()),
    );
    attributes.insert(
        "signature".to_string(),
        Value::String(spec.signature.clone()),
    );
    attributes.insert("lineStart".to_string(), json!(spec.line_start));
    attributes.insert("lineEnd".to_string(), json!(spec.line_end));
    if spec.test {
        attributes.insert("test".to_string(), Value::Bool(true));
    }
    if spec.cfg_test {
        attributes.insert("cfgTest".to_string(), Value::Bool(true));
    }
    attributes
}

fn line_span<T: Spanned>(node: &T) -> (usize, usize) {
    let span = node.span();
    let start = span.start();
    let end = span.end();
    (start.line, end.line)
}

fn is_exported(visibility: &Visibility) -> bool {
    !matches!(visibility, Visibility::Inherited)
}

fn has_test_attr(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|attr| attr.path().is_ident("test"))
}

fn has_cfg_test_attr(attrs: &[syn::Attribute]) -> bool {
    attrs
        .iter()
        .any(|attr| attr.path().is_ident("cfg") && is_exact_cfg_test_attr(attr))
}

fn is_exact_cfg_test_attr(attr: &syn::Attribute) -> bool {
    let mut nested_count = 0_usize;
    let mut direct_test = false;
    let parsed = attr.parse_nested_meta(|meta| {
        nested_count += 1;
        if meta.path.is_ident("test") && meta.input.is_empty() {
            direct_test = true;
        }
        Ok(())
    });
    parsed.is_ok() && nested_count == 1 && direct_test
}

fn type_name(ty: &Type) -> String {
    match ty {
        Type::Path(path) => path_to_string(&path.path)
            .unwrap_or_else(|| normalize_tokens(path.to_token_stream().to_string())),
        _ => normalize_tokens(ty.to_token_stream().to_string()),
    }
}

fn qualify_type_name(current_module: &str, name: &str) -> String {
    if name.contains("::") {
        if name.starts_with("crate::") {
            return name.to_string();
        }
        return format!("crate::{name}");
    }
    format!("{current_module}::{name}")
}

fn path_to_string(path: &syn::Path) -> Option<String> {
    let parts = path
        .segments
        .iter()
        .map(|segment| segment.ident.to_string())
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join("::"))
}

fn canonical_use_target(
    segments: Vec<String>,
    current_module: &str,
    manifest: &RustManifest,
    path: &str,
) -> Option<(String, Option<String>)> {
    let raw = segments.join("::");
    let first = segments.first()?;
    if first == "crate" {
        return Some((raw, None));
    }
    if first == "self" {
        return Some((relative_use_target(&segments, current_module), None));
    }
    if first == "super" {
        return Some((relative_use_target(&segments, current_module), None));
    }
    if let Some(dependency) = manifest.dependency_for_path_segment(path, first) {
        return Some((raw, Some(dependency)));
    }
    if is_standard_crate(first) {
        return Some((raw, None));
    }
    Some((format!("crate::{raw}"), None))
}

fn use_leaf_target(mut prefix: Vec<String>, leaf: &str) -> Vec<String> {
    if leaf != "self" || prefix.is_empty() {
        prefix.push(leaf.to_string());
    }
    prefix
}

fn relative_use_target(segments: &[String], current_module: &str) -> String {
    let mut module = current_module
        .split("::")
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let mut rest = Vec::new();
    let mut in_relative_prefix = true;

    for segment in segments {
        if in_relative_prefix && segment == "self" {
            continue;
        }
        if in_relative_prefix && segment == "super" {
            if module.len() > 1 {
                module.pop();
            }
            continue;
        }
        in_relative_prefix = false;
        rest.push(segment.clone());
    }

    if module.is_empty() {
        module.push("crate".to_string());
    }
    let base = module.join("::");
    if rest.is_empty() {
        base
    } else {
        format!("{}::{}", base, rest.join("::"))
    }
}

fn is_standard_crate(segment: &str) -> bool {
    matches!(segment, "std" | "core" | "alloc" | "proc_macro")
}

fn last_path_segment(path: &str) -> String {
    path.split("::")
        .last()
        .filter(|segment| !segment.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn sanitize_id_part(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == ':' {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn normalize_tokens(value: String) -> String {
    let mut normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    for (from, to) in [
        (" :: ", "::"),
        (" < ", "<"),
        (" >", ">"),
        (" (", "("),
        (" )", ")"),
        (" ,", ","),
        (" ;", ";"),
        (" !", "!"),
        (" & ", "&"),
    ] {
        normalized = normalized.replace(from, to);
    }
    normalized
}

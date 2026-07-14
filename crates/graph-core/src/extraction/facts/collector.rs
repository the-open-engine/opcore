use super::{
    file_id, insert_edge, EdgeDraft, FileFacts, HeritageFact, ImportBinding, ImportFact,
    ReExportFact, ReferenceFact,
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

pub(super) fn collect_file_facts(
    path: String,
    file_node: GraphFactNode,
    program: &oxc_ast::ast::Program<'_>,
) -> FileFacts {
    let mut collector = FileFactCollector::new(path, file_node);
    collector.visit_program(program);
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
            .is_some_and(|export| registers_default_export_alias(export, name));
        match self.nodes.entry(id.clone()) {
            Entry::Occupied(mut entry) => {
                if let Some(export) = &export {
                    apply_export_attributes(entry.get_mut(), export, name);
                } else {
                    ensure_export_attribute(entry.get_mut());
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
                    apply_export_attributes(&mut node, export, name);
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
        let file = file_id(&self.path);
        insert_edge(&mut self.edges, EdgeDraft::new("CONTAINS", &file, &id));
        id
    }

    fn add_default_declaration(&mut self, prefix: &str, kind: &str) -> String {
        let name = "default";
        let id = format!("{prefix}:{}#{name}", self.path);
        match self.nodes.entry(id.clone()) {
            Entry::Occupied(mut entry) => {
                apply_export_attributes(entry.get_mut(), &ExportContext::default(), name);
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
                apply_export_attributes(&mut node, &ExportContext::default(), name);
                entry.insert(node);
            }
        }
        self.declarations.insert(name.to_string(), id.clone());
        self.top_level_declarations
            .insert(name.to_string(), id.clone());
        self.register_export_alias(&ExportContext::default(), name, &id);
        let file = file_id(&self.path);
        insert_edge(&mut self.edges, EdgeDraft::new("CONTAINS", &file, &id));
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
        let file = file_id(&self.path);
        insert_edge(&mut self.edges, EdgeDraft::new("CONTAINS", &file, &id));
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
                apply_export_attributes(node, &export, local);
            }
            if registers_default_export_alias(&export, local) {
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

impl<'a> Visit<'a> for FileFactCollector {
    fn visit_import_declaration(&mut self, import: &ImportDeclaration<'a>) {
        self.imports.push(ImportFact {
            specifier: import.source.value.to_string(),
            bindings: import_bindings(import.specifiers.as_ref()),
        });
    }

    fn visit_import_expression(&mut self, import: &ImportExpression<'a>) {
        if let Expression::StringLiteral(source) = &import.source {
            self.imports.push(ImportFact {
                specifier: source.value.to_string(),
                bindings: Vec::new(),
            });
        }
        walk::walk_import_expression(self, import);
    }

    fn visit_ts_import_type(&mut self, import: &TSImportType<'a>) {
        self.imports.push(ImportFact {
            specifier: import.source.value.to_string(),
            bindings: Vec::new(),
        });
        walk::walk_ts_import_type(self, import);
    }

    fn visit_export_named_declaration(&mut self, export: &ExportNamedDeclaration<'a>) {
        let source = export
            .source
            .as_ref()
            .map(|source| source.value.to_string());
        if let Some(source) = &source {
            self.imports.push(ImportFact {
                specifier: source.clone(),
                bindings: export
                    .specifiers
                    .iter()
                    .map(|specifier| ImportBinding {
                        local: module_export_name(&specifier.exported),
                        imported: module_export_name(&specifier.local),
                    })
                    .collect(),
            });
        }
        if let Some(declaration) = &export.declaration {
            self.with_export(ExportContext::named(None), |collector| {
                collector.visit_declaration(declaration)
            });
        }
        for specifier in &export.specifiers {
            let local = module_export_name(&specifier.local);
            let exported = module_export_name(&specifier.exported);
            if let Some(source) = &source {
                self.re_exports.push(ReExportFact {
                    specifier: source.clone(),
                    imported: local.clone(),
                    exported: exported.clone(),
                });
                self.record_file_export(json!({
                    "kind": "named",
                    "local": local,
                    "exported": exported,
                    "source": source,
                    "imported": module_export_name(&specifier.local),
                    "supportedSymbol": false
                }));
            } else {
                if !self.top_level_declarations.contains_key(&local) {
                    if let Some(imported) = self.import_backed_local(&local) {
                        self.record_file_export(json!({
                            "kind": "named",
                            "local": local,
                            "exported": exported,
                            "source": imported.source,
                            "imported": imported.imported,
                            "supportedSymbol": false
                        }));
                        continue;
                    }
                }
                self.mark_exported(&local, ExportContext::named(Some(exported.clone())));
                self.record_file_export(json!({
                    "kind": "named",
                    "local": local,
                    "exported": exported,
                    "source": null,
                    "supportedSymbol": true
                }));
            }
        }
    }

    fn visit_export_all_declaration(&mut self, export: &ExportAllDeclaration<'a>) {
        self.imports.push(ImportFact {
            specifier: export.source.value.to_string(),
            bindings: Vec::new(),
        });
        let source = export.source.value.to_string();
        if let Some(exported) = &export.exported {
            self.record_file_export(json!({
                "kind": "namespace",
                "exported": module_export_name(exported),
                "source": source,
                "supportedSymbol": false
            }));
        } else {
            self.record_file_export(json!({
                "kind": "all",
                "exported": "*",
                "source": source,
                "supportedSymbol": false
            }));
        }
    }

    fn visit_export_default_declaration(&mut self, export: &ExportDefaultDeclaration<'a>) {
        match &export.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                self.record_file_export(json!({
                    "kind": "default",
                    "local": function_name(function).unwrap_or_else(|| "default".to_string()),
                    "exported": "default",
                    "source": null,
                    "supportedSymbol": true
                }));
                self.with_export(ExportContext::default(), |collector| {
                    collector.visit_function(function, ScopeFlags::Function)
                });
            }
            ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                self.record_file_export(json!({
                    "kind": "default",
                    "local": class_name(class).unwrap_or_else(|| "default".to_string()),
                    "exported": "default",
                    "source": null,
                    "supportedSymbol": true
                }));
                self.with_export(ExportContext::default(), |collector| {
                    collector.visit_class(class)
                });
            }
            ExportDefaultDeclarationKind::TSInterfaceDeclaration(declaration) => {
                self.record_file_export(json!({
                    "kind": "default",
                    "local": declaration.id.name.as_ref(),
                    "exported": "default",
                    "source": null,
                    "supportedSymbol": true
                }));
                self.with_export(ExportContext::default(), |collector| {
                    collector.visit_ts_interface_declaration(declaration)
                });
            }
            _ => {
                let expression = export.declaration.to_expression();
                let local = default_export_local(expression);
                if let Some(local) = &local {
                    if !self.top_level_declarations.contains_key(local) {
                        if let Some(imported) = self.import_backed_local(local) {
                            self.record_file_export(json!({
                                "kind": "default",
                                "local": local,
                                "exported": "default",
                                "source": imported.source,
                                "imported": imported.imported,
                                "supportedSymbol": false
                            }));
                            self.visit_expression(expression);
                            return;
                        }
                    }
                    self.mark_exported(local, ExportContext::default());
                }
                self.record_file_export(json!({
                    "kind": "default",
                    "local": local,
                    "exported": "default",
                    "source": null,
                    "supportedSymbol": local.is_some()
                }));
                self.visit_expression(expression);
            }
        }
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        if let Some(name) = function_name(function) {
            let id = self.add_declaration("function", "Function", &name);
            self.with_context(id, |collector| {
                walk::walk_function(collector, function, flags)
            });
        } else if self
            .current_export
            .as_ref()
            .is_some_and(|export| export.export_kind == "default")
        {
            let id = self.add_default_declaration("function", "Function");
            self.with_context(id, |collector| {
                walk::walk_function(collector, function, flags)
            });
        } else {
            walk::walk_function(self, function, flags);
        }
    }

    fn visit_class(&mut self, class: &Class<'a>) {
        if let Some(name) = class_name(class) {
            let id = self.add_declaration("class", "Class", &name);
            if let Some(super_class) = class.super_class.as_ref().and_then(expression_name) {
                self.heritage.push(HeritageFact {
                    from: id.clone(),
                    name: super_class,
                    kind: "INHERITS".to_string(),
                });
            }
            for implemented in &class.implements {
                if let Some(name) = ts_type_name(&implemented.expression) {
                    self.heritage.push(HeritageFact {
                        from: id.clone(),
                        name,
                        kind: "IMPLEMENTS".to_string(),
                    });
                }
            }
            self.with_context(id, |collector| walk::walk_class(collector, class));
        } else if self
            .current_export
            .as_ref()
            .is_some_and(|export| export.export_kind == "default")
        {
            let id = self.add_default_declaration("class", "Class");
            self.with_context(id, |collector| walk::walk_class(collector, class));
        } else {
            walk::walk_class(self, class);
        }
    }

    fn visit_ts_type_alias_declaration(&mut self, declaration: &TSTypeAliasDeclaration<'a>) {
        self.add_declaration("type", "Type", declaration.id.name.as_ref());
        walk::walk_ts_type_alias_declaration(self, declaration);
    }

    fn visit_ts_interface_declaration(&mut self, declaration: &TSInterfaceDeclaration<'a>) {
        let id = self.add_declaration("type", "Type", declaration.id.name.as_ref());
        for extended in &declaration.extends {
            if let Some(name) = expression_name(&extended.expression) {
                self.heritage.push(HeritageFact {
                    from: id.clone(),
                    name,
                    kind: "INHERITS".to_string(),
                });
            }
        }
        walk::walk_ts_interface_declaration(self, declaration);
    }

    fn visit_variable_declaration(&mut self, declaration: &VariableDeclaration<'a>) {
        for declarator in &declaration.declarations {
            if let Some(type_annotation) = &declarator.type_annotation {
                self.visit_ts_type_annotation(type_annotation);
            }
            if let Some(name) = binding_name(&declarator.id) {
                if self.current_context.is_none() {
                    let Some(init) = declarator.init.as_ref() else {
                        self.add_declaration("variable", "Variable", &name);
                        continue;
                    };
                    if is_function_like(init) {
                        let id = self.add_declaration("function", "Function", &name);
                        self.with_context(id, |collector| collector.visit_expression(init));
                    } else {
                        let id = self.add_declaration("variable", "Variable", &name);
                        self.with_context(id, |collector| collector.visit_expression(init));
                    }
                    continue;
                }
            }
            if let Some(init) = declarator.init.as_ref() {
                self.visit_expression(init);
            }
        }
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if let Some(callee) = expression_name(&call.callee) {
            if callee == "test" || callee == "it" {
                let Some(test_name) = first_string_argument(&call.arguments) else {
                    walk::walk_call_expression(self, call);
                    return;
                };
                let test_id = self.add_test(&test_name);
                self.with_context(test_id, |collector| {
                    walk::walk_call_expression(collector, call)
                });
                return;
            }
            if callee != "describe" && callee != "test" && callee != "it" {
                self.add_reference(callee);
            }
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_new_expression(&mut self, expression: &NewExpression<'a>) {
        if let Some(callee) = expression_name(&expression.callee) {
            self.add_reference(callee);
        }
        walk::walk_new_expression(self, expression);
    }
}

fn import_bindings(
    specifiers: Option<&oxc_allocator::Vec<'_, ImportDeclarationSpecifier<'_>>>,
) -> Vec<ImportBinding> {
    specifiers
        .into_iter()
        .flat_map(|items| items.iter())
        .map(|specifier| match specifier {
            ImportDeclarationSpecifier::ImportSpecifier(specifier) => ImportBinding {
                local: specifier.local.name.to_string(),
                imported: module_export_name(&specifier.imported),
            },
            ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => ImportBinding {
                local: specifier.local.name.to_string(),
                imported: "default".to_string(),
            },
            ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => ImportBinding {
                local: specifier.local.name.to_string(),
                imported: "*".to_string(),
            },
        })
        .collect()
}

fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(name) => name.name.to_string(),
        ModuleExportName::IdentifierReference(name) => name.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}

fn binding_name(pattern: &BindingPattern<'_>) -> Option<String> {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => Some(identifier.name.to_string()),
        _ => None,
    }
}

fn is_function_like(expression: &Expression<'_>) -> bool {
    matches!(
        expression,
        Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)
    )
}

fn first_string_argument(arguments: &oxc_allocator::Vec<'_, Argument<'_>>) -> Option<String> {
    arguments.first().and_then(|argument| match argument {
        Argument::StringLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    })
}

fn expression_name(expression: &Expression<'_>) -> Option<String> {
    let expression = unwrapped_expression(expression);
    match expression {
        Expression::Identifier(identifier) => Some(identifier.name.to_string()),
        Expression::StaticMemberExpression(member) => static_member_name(member),
        _ => None,
    }
}

fn unwrapped_expression<'a>(expression: &'a Expression<'a>) -> &'a Expression<'a> {
    let mut current = expression;
    loop {
        current = match current {
            Expression::ParenthesizedExpression(expression) => &expression.expression,
            Expression::TSAsExpression(expression) => &expression.expression,
            Expression::TSSatisfiesExpression(expression) => &expression.expression,
            Expression::TSNonNullExpression(expression) => &expression.expression,
            Expression::TSInstantiationExpression(expression) => &expression.expression,
            _ => return current,
        };
    }
}

fn static_member_name(member: &oxc_ast::ast::StaticMemberExpression<'_>) -> Option<String> {
    let property = member.property.name.to_string();
    match &member.object {
        Expression::Identifier(object) => Some(format!("{}.{}", object.name, property)),
        _ => Some(property),
    }
}

fn ts_type_name(name: &TSTypeName<'_>) -> Option<String> {
    match name {
        TSTypeName::IdentifierReference(identifier) => Some(identifier.name.to_string()),
        TSTypeName::QualifiedName(_) | TSTypeName::ThisExpression(_) => None,
    }
}

fn function_name(function: &Function<'_>) -> Option<String> {
    function.id.as_ref().map(|id| id.name.to_string())
}

fn class_name(class: &Class<'_>) -> Option<String> {
    class.id.as_ref().map(|id| id.name.to_string())
}

fn default_export_local(expression: &Expression<'_>) -> Option<String> {
    match unwrapped_expression(expression) {
        Expression::Identifier(identifier) => Some(identifier.name.to_string()),
        _ => None,
    }
}

fn ensure_export_attribute(node: &mut GraphFactNode) {
    let attributes = attributes_object(node);
    attributes
        .entry("exported".to_string())
        .or_insert_with(|| Value::Bool(false));
}

fn apply_export_attributes(node: &mut GraphFactNode, export: &ExportContext, local_name: &str) {
    let attributes = attributes_object(node);
    attributes.insert("exported".to_string(), Value::Bool(true));
    attributes.insert(
        "exportKind".to_string(),
        Value::String(export.export_kind.clone()),
    );
    attributes.insert(
        "exportName".to_string(),
        Value::String(export.export_name_for(local_name)),
    );
}

fn registers_default_export_alias(export: &ExportContext, local_name: &str) -> bool {
    export.export_kind == "default" || export.export_name_for(local_name) == "default"
}

fn set_attribute(node: &mut GraphFactNode, key: &str, value: Value) {
    attributes_object(node).insert(key.to_string(), value);
}

fn attributes_object(node: &mut GraphFactNode) -> &mut serde_json::Map<String, Value> {
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

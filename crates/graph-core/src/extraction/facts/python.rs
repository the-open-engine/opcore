use super::{
    set_node_attribute, EdgeDraft, FactResolution, FileFacts, HeritageFact, ImportBinding,
    ImportFact, ReExportFact, ReferenceFact, Resolution,
};
use crate::protocol::{GraphFactEdge, GraphFactNode};
use serde_json::{json, Value};
use std::collections::{btree_map::Entry, BTreeMap, BTreeSet};
use std::path::Path;
use tree_sitter::{Node, Tree};

mod syntax;

use syntax::{PythonSyntax, Syntax};

pub(super) fn collect_file_facts(
    path: String,
    file_node: GraphFactNode,
    source_text: &str,
    tree: &Tree,
) -> FileFacts {
    let root = tree.root_node();
    let explicit_exports = Syntax::collect_explicit_exports(root, source_text);
    let mut collector =
        PythonFileFactCollector::new(path, file_node, source_text, explicit_exports);
    collector.visit_module(root);
    collector.finish()
}

struct PythonFileFactCollector<'a> {
    path: String,
    file_node: GraphFactNode,
    source_text: &'a str,
    nodes: BTreeMap<String, GraphFactNode>,
    edges: BTreeMap<String, GraphFactEdge>,
    declarations: BTreeMap<String, String>,
    top_level_declarations: BTreeMap<String, String>,
    imports: Vec<ImportFact>,
    references: Vec<ReferenceFact>,
    heritage: Vec<HeritageFact>,
    export_aliases: BTreeMap<String, String>,
    file_exports: Vec<Value>,
    explicit_exports: Option<BTreeSet<String>>,
    module_id: String,
    current_parent: String,
    qualifier: Vec<String>,
    test_class_depth: usize,
}

impl<'a> PythonFileFactCollector<'a> {
    fn new(
        path: String,
        file_node: GraphFactNode,
        source_text: &'a str,
        explicit_exports: Option<BTreeSet<String>>,
    ) -> Self {
        let module_name = Syntax::module_name_for_path(&path);
        let module_id = format!("module:{path}#{module_name}");
        let mut nodes = BTreeMap::new();
        nodes.insert(
            module_id.clone(),
            GraphFactNode {
                id: module_id.clone(),
                kind: "Module".to_string(),
                path: Some(path.clone()),
                name: Some(module_name.clone()),
                attributes: Some(json!({ "dottedName": module_name })),
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
            source_text,
            nodes,
            edges,
            declarations: BTreeMap::new(),
            top_level_declarations: BTreeMap::new(),
            imports: Vec::new(),
            references: Vec::new(),
            heritage: Vec::new(),
            export_aliases: BTreeMap::new(),
            file_exports: Vec::new(),
            explicit_exports,
            module_id: module_id.clone(),
            current_parent: module_id,
            qualifier: Vec::new(),
            test_class_depth: 0,
        }
    }

    fn finish(mut self) -> FileFacts {
        if let Some(explicit_exports) = self.explicit_exports.clone() {
            for export_name in explicit_exports {
                if !self.file_exports.iter().any(|entry| {
                    entry.get("exported").and_then(Value::as_str) == Some(&export_name)
                }) {
                    self.file_exports.push(json!({
                        "kind": "named",
                        "local": export_name,
                        "exported": export_name,
                        "source": null,
                        "supportedSymbol": false,
                        "policy": "__all__"
                    }));
                }
            }
        }
        if self.explicit_exports.is_some() || !self.file_exports.is_empty() {
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

    fn visit_module(&mut self, node: Node<'_>) {
        for child in Syntax::named_children(node) {
            self.visit_statement(child, Vec::new());
        }
    }

    fn visit_statement(&mut self, node: Node<'_>, decorators: Vec<String>) {
        if self.visit_definition(node, decorators) {
            return;
        }
        match node.kind() {
            "import_statement" => self.visit_import_statement(node),
            "import_from_statement" => self.visit_import_from_statement(node),
            "assignment" => self.visit_assignment(node),
            "expression_statement" => self.visit_expression_statement(node),
            "block" | "module" => {
                for child in Syntax::named_children(node) {
                    self.visit_statement(child, Vec::new());
                }
            }
            "call" => self.visit_call(node),
            _ => self.visit_children_for_references(node),
        }
    }

    fn visit_definition(&mut self, node: Node<'_>, decorators: Vec<String>) -> bool {
        match node.kind() {
            "decorated_definition" => self.visit_decorated_definition(node),
            "class_definition" => self.visit_class(node, decorators),
            "function_definition" => self.visit_function(node, decorators),
            _ => return false,
        }
        true
    }

    fn visit_decorated_definition(&mut self, node: Node<'_>) {
        let decorators = Syntax::named_children(node)
            .into_iter()
            .filter(|child| child.kind() == "decorator")
            .filter_map(|child| Syntax::decorator_name(child, self.source_text))
            .collect::<Vec<_>>();
        if let Some(definition) = node.child_by_field_name("definition") {
            self.visit_statement(definition, decorators);
        }
    }

    fn visit_class(&mut self, node: Node<'_>, decorators: Vec<String>) {
        let Some(name) = Syntax::field_text(node, "name", self.source_text) else {
            self.visit_children_for_references(node);
            return;
        };
        let bases = Syntax::class_bases(node, self.source_text);
        let is_test = Syntax::is_test_class(&name, &bases);
        let id = self.add_declaration(PythonDeclarationDraft {
            prefix: "class",
            kind: "Class",
            name: &name,
            extra_attributes: json!({
                "decorators": decorators,
                "isTest": is_test
            }),
        });
        for base in bases {
            self.heritage.push(HeritageFact {
                from: id.clone(),
                name: base,
                kind: "INHERITS".to_string(),
            });
        }
        let body = node.child_by_field_name("body");
        self.with_parent(ParentScope::new(id, name, is_test), |collector| {
            if let Some(body) = body {
                collector.visit_statement(body, Vec::new());
            }
        });
    }

    fn visit_function(&mut self, node: Node<'_>, decorators: Vec<String>) {
        let Some(name) = Syntax::field_text(node, "name", self.source_text) else {
            self.visit_children_for_references(node);
            return;
        };
        let is_async = Syntax::node_text(node, self.source_text)
            .trim_start()
            .starts_with("async def");
        let is_test = Syntax::is_test_function(&self.path, &name, self.test_class_depth > 0);
        let id = self.add_declaration(PythonDeclarationDraft {
            prefix: "function",
            kind: "Function",
            name: &name,
            extra_attributes: json!({
                "async": is_async,
                "decorators": decorators,
                "isTest": is_test
            }),
        });
        let body = node.child_by_field_name("body");
        self.with_parent(ParentScope::new(id, name, false), |collector| {
            if let Some(body) = body {
                collector.visit_statement(body, Vec::new());
            }
        });
    }

    fn visit_import_statement(&mut self, node: Node<'_>) {
        self.imports
            .extend(Syntax::parse_import_statement(&Syntax::node_text(
                node,
                self.source_text,
            )));
    }

    fn visit_import_from_statement(&mut self, node: Node<'_>) {
        self.imports
            .extend(Syntax::parse_from_import_statement(&Syntax::node_text(
                node,
                self.source_text,
            )));
    }

    fn visit_expression_statement(&mut self, node: Node<'_>) {
        if let Some(assignment) = Syntax::named_children(node)
            .into_iter()
            .find(|child| child.kind() == "assignment")
        {
            self.visit_assignment(assignment);
            return;
        }
        self.visit_children_for_references(node);
    }

    fn visit_assignment(&mut self, node: Node<'_>) {
        let left = node.child_by_field_name("left");
        let right = node.child_by_field_name("right");
        if self.current_parent == self.module_id {
            if let Some(name) =
                left.and_then(|left| Syntax::assignment_name(left, self.source_text))
            {
                if name != "__all__" {
                    let id = self.add_declaration(PythonDeclarationDraft {
                        prefix: "variable",
                        kind: "Variable",
                        name: &name,
                        extra_attributes: json!({}),
                    });
                    if let Some(right) = right {
                        self.with_existing_parent(id, |collector| {
                            collector.visit_children_for_references(right)
                        });
                    }
                    return;
                }
            }
        }
        if let Some(right) = right {
            self.visit_children_for_references(right);
        }
    }

    fn visit_call(&mut self, node: Node<'_>) {
        if let Some(function) = node.child_by_field_name("function") {
            if let Some(name) = Syntax::expression_name(function, self.source_text) {
                if !Syntax::is_builtin_reference(&name) {
                    self.references.push(ReferenceFact {
                        from: self.current_parent.clone(),
                        name,
                        is_test: self.current_function_is_test(),
                    });
                }
            }
        }
        if let Some(arguments) = node.child_by_field_name("arguments") {
            self.visit_children_for_references(arguments);
        }
    }

    fn visit_children_for_references(&mut self, node: Node<'_>) {
        if node.kind() == "call" {
            self.visit_call(node);
            return;
        }
        for child in Syntax::named_children(node) {
            self.visit_statement(child, Vec::new());
        }
    }

    fn add_declaration(&mut self, draft: PythonDeclarationDraft<'_>) -> String {
        let qualifier = self.qualified_name(draft.name);
        let id = format!("{}:{}#{qualifier}", draft.prefix, self.path);
        let is_top_level = self.current_parent == self.module_id;
        let export =
            Syntax::export_policy(draft.name, is_top_level, self.explicit_exports.as_ref());
        let mut attributes = serde_json::Map::new();
        attributes.insert("exported".to_string(), Value::Bool(export.exported));
        attributes.insert(
            "exportPolicy".to_string(),
            Value::String(export.policy.to_string()),
        );
        if export.exported {
            attributes.insert("exportKind".to_string(), Value::String("named".to_string()));
            attributes.insert(
                "exportName".to_string(),
                Value::String(draft.name.to_string()),
            );
        }
        if let Value::Object(extra) = draft.extra_attributes {
            for (key, value) in extra {
                attributes.insert(key, value);
            }
        }

        match self.nodes.entry(id.clone()) {
            Entry::Occupied(mut entry) => {
                entry.get_mut().attributes = Some(Value::Object(attributes));
            }
            Entry::Vacant(entry) => {
                entry.insert(GraphFactNode {
                    id: id.clone(),
                    kind: draft.kind.to_string(),
                    path: Some(self.path.clone()),
                    name: Some(draft.name.to_string()),
                    attributes: Some(Value::Object(attributes)),
                });
            }
        }
        self.declarations.insert(draft.name.to_string(), id.clone());
        self.declarations.insert(qualifier, id.clone());
        if is_top_level {
            self.top_level_declarations
                .insert(draft.name.to_string(), id.clone());
            if export.exported {
                self.export_aliases
                    .insert(draft.name.to_string(), id.clone());
                self.file_exports.push(json!({
                    "kind": "named",
                    "local": draft.name,
                    "exported": draft.name,
                    "source": null,
                    "supportedSymbol": true,
                    "policy": export.policy
                }));
            }
        }
        Resolution::insert_edge(
            &mut self.edges,
            EdgeDraft::new("CONTAINS", &self.current_parent, &id),
        );
        id
    }

    fn qualified_name(&self, name: &str) -> String {
        if self.qualifier.is_empty() {
            return name.to_string();
        }
        format!("{}.{}", self.qualifier.join("."), name)
    }

    fn with_parent(&mut self, scope: ParentScope, visit: impl FnOnce(&mut Self)) {
        let previous_parent = std::mem::replace(&mut self.current_parent, scope.parent);
        self.qualifier.push(scope.name);
        if scope.is_test_class {
            self.test_class_depth += 1;
        }
        visit(self);
        if scope.is_test_class {
            self.test_class_depth = self.test_class_depth.saturating_sub(1);
        }
        self.qualifier.pop();
        self.current_parent = previous_parent;
    }

    fn with_existing_parent(&mut self, parent: String, visit: impl FnOnce(&mut Self)) {
        let previous_parent = std::mem::replace(&mut self.current_parent, parent);
        visit(self);
        self.current_parent = previous_parent;
    }

    fn current_function_is_test(&self) -> bool {
        self.nodes
            .get(&self.current_parent)
            .and_then(|node| node.attributes.as_ref())
            .and_then(|attributes| attributes.get("isTest"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }
}

struct PythonDeclarationDraft<'a> {
    prefix: &'a str,
    kind: &'a str,
    name: &'a str,
    extra_attributes: Value,
}

struct ParentScope {
    parent: String,
    name: String,
    is_test_class: bool,
}

impl ParentScope {
    fn new(parent: String, name: String, is_test_class: bool) -> Self {
        Self {
            parent,
            name,
            is_test_class,
        }
    }
}

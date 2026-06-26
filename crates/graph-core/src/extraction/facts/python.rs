use super::{
    file_id, insert_edge, EdgeDraft, FileFacts, HeritageFact, ImportBinding, ImportFact,
    ReExportFact, ReferenceFact,
};
use crate::protocol::{GraphFactEdge, GraphFactNode};
use serde_json::{json, Value};
use std::collections::{btree_map::Entry, BTreeMap, BTreeSet};
use std::path::Path;
use tree_sitter::{Node, Tree};

pub(super) fn collect_file_facts(
    path: String,
    file_node: GraphFactNode,
    source_text: &str,
    tree: &Tree,
) -> FileFacts {
    let root = tree.root_node();
    let explicit_exports = collect_explicit_exports(root, source_text);
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
        let module_name = module_name_for_path(&path);
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
        insert_edge(
            &mut edges,
            EdgeDraft::new("CONTAINS", &file_id(&path), &module_id),
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

    fn visit_module(&mut self, node: Node<'_>) {
        for child in named_children(node) {
            self.visit_statement(child, Vec::new());
        }
    }

    fn visit_statement(&mut self, node: Node<'_>, decorators: Vec<String>) {
        match node.kind() {
            "decorated_definition" => self.visit_decorated_definition(node),
            "class_definition" => self.visit_class(node, decorators),
            "function_definition" => self.visit_function(node, decorators),
            "import_statement" => self.visit_import_statement(node),
            "import_from_statement" => self.visit_import_from_statement(node),
            "assignment" => self.visit_assignment(node),
            "expression_statement" => self.visit_expression_statement(node),
            "block" | "module" => {
                for child in named_children(node) {
                    self.visit_statement(child, Vec::new());
                }
            }
            "call" => self.visit_call(node),
            _ => self.visit_children_for_references(node),
        }
    }

    fn visit_decorated_definition(&mut self, node: Node<'_>) {
        let decorators = named_children(node)
            .into_iter()
            .filter(|child| child.kind() == "decorator")
            .filter_map(|child| decorator_name(child, self.source_text))
            .collect::<Vec<_>>();
        if let Some(definition) = node.child_by_field_name("definition") {
            self.visit_statement(definition, decorators);
        }
    }

    fn visit_class(&mut self, node: Node<'_>, decorators: Vec<String>) {
        let Some(name) = field_text(node, "name", self.source_text) else {
            self.visit_children_for_references(node);
            return;
        };
        let bases = class_bases(node, self.source_text);
        let is_test = is_test_class(&name, &bases);
        let id = self.add_declaration(
            "class",
            "Class",
            &name,
            json!({
                "decorators": decorators,
                "isTest": is_test
            }),
        );
        for base in bases {
            self.heritage.push(HeritageFact {
                from: id.clone(),
                name: base,
                kind: "INHERITS".to_string(),
            });
        }
        let body = node.child_by_field_name("body");
        self.with_parent(id, name, is_test, |collector| {
            if let Some(body) = body {
                collector.visit_statement(body, Vec::new());
            }
        });
    }

    fn visit_function(&mut self, node: Node<'_>, decorators: Vec<String>) {
        let Some(name) = field_text(node, "name", self.source_text) else {
            self.visit_children_for_references(node);
            return;
        };
        let is_async = node_text(node, self.source_text)
            .trim_start()
            .starts_with("async def");
        let is_test = is_test_function(&self.path, &name, self.test_class_depth > 0);
        let id = self.add_declaration(
            "function",
            "Function",
            &name,
            json!({
                "async": is_async,
                "decorators": decorators,
                "isTest": is_test
            }),
        );
        let body = node.child_by_field_name("body");
        self.with_parent(id, name, false, |collector| {
            if let Some(body) = body {
                collector.visit_statement(body, Vec::new());
            }
        });
    }

    fn visit_import_statement(&mut self, node: Node<'_>) {
        self.imports
            .extend(parse_import_statement(&node_text(node, self.source_text)));
    }

    fn visit_import_from_statement(&mut self, node: Node<'_>) {
        self.imports.extend(parse_from_import_statement(&node_text(
            node,
            self.source_text,
        )));
    }

    fn visit_expression_statement(&mut self, node: Node<'_>) {
        if let Some(assignment) = named_children(node)
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
            if let Some(name) = left.and_then(|left| assignment_name(left, self.source_text)) {
                if name != "__all__" {
                    let id = self.add_declaration("variable", "Variable", &name, json!({}));
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
            if let Some(name) = expression_name(function, self.source_text) {
                if !is_builtin_reference(&name) {
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
        for child in named_children(node) {
            self.visit_statement(child, Vec::new());
        }
    }

    fn add_declaration(
        &mut self,
        prefix: &str,
        kind: &str,
        name: &str,
        extra_attributes: Value,
    ) -> String {
        let qualifier = self.qualified_name(name);
        let id = format!("{prefix}:{}#{qualifier}", self.path);
        let is_top_level = self.current_parent == self.module_id;
        let export = export_policy(name, is_top_level, self.explicit_exports.as_ref());
        let mut attributes = serde_json::Map::new();
        attributes.insert("exported".to_string(), Value::Bool(export.exported));
        attributes.insert(
            "exportPolicy".to_string(),
            Value::String(export.policy.to_string()),
        );
        if export.exported {
            attributes.insert("exportKind".to_string(), Value::String("named".to_string()));
            attributes.insert("exportName".to_string(), Value::String(name.to_string()));
        }
        if let Value::Object(extra) = extra_attributes {
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
                    kind: kind.to_string(),
                    path: Some(self.path.clone()),
                    name: Some(name.to_string()),
                    attributes: Some(Value::Object(attributes)),
                });
            }
        }
        self.declarations.insert(name.to_string(), id.clone());
        self.declarations.insert(qualifier, id.clone());
        if is_top_level {
            self.top_level_declarations
                .insert(name.to_string(), id.clone());
            if export.exported {
                self.export_aliases.insert(name.to_string(), id.clone());
                self.file_exports.push(json!({
                    "kind": "named",
                    "local": name,
                    "exported": name,
                    "source": null,
                    "supportedSymbol": true,
                    "policy": export.policy
                }));
            }
        }
        insert_edge(
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

    fn with_parent(
        &mut self,
        parent: String,
        name: String,
        is_test_class: bool,
        visit: impl FnOnce(&mut Self),
    ) {
        let previous_parent = std::mem::replace(&mut self.current_parent, parent);
        self.qualifier.push(name);
        if is_test_class {
            self.test_class_depth += 1;
        }
        visit(self);
        if is_test_class {
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

struct ExportPolicy<'a> {
    exported: bool,
    policy: &'a str,
}

fn export_policy(
    name: &str,
    is_top_level: bool,
    explicit_exports: Option<&BTreeSet<String>>,
) -> ExportPolicy<'static> {
    if !is_top_level {
        return ExportPolicy {
            exported: false,
            policy: "not_module_level",
        };
    }
    if let Some(exports) = explicit_exports {
        return ExportPolicy {
            exported: exports.contains(name),
            policy: "__all__",
        };
    }
    ExportPolicy {
        exported: !name.starts_with('_'),
        policy: "underscore_convention",
    }
}

fn collect_explicit_exports(root: Node<'_>, source_text: &str) -> Option<BTreeSet<String>> {
    let mut exports = BTreeSet::new();
    let mut found = false;
    for statement in named_children(root) {
        let Some(node) = module_level_assignment(statement) else {
            continue;
        };
        let left = node.child_by_field_name("left");
        if left
            .and_then(|left| assignment_name(left, source_text))
            .as_deref()
            != Some("__all__")
        {
            continue;
        }
        found = true;
        if let Some(right) = node.child_by_field_name("right") {
            for string_node in descendant_nodes(right) {
                if string_node.kind() == "string" {
                    if let Some(value) = parse_string_literal(&node_text(string_node, source_text))
                    {
                        exports.insert(value);
                    }
                }
            }
        }
    }
    found.then_some(exports)
}

fn module_level_assignment(node: Node<'_>) -> Option<Node<'_>> {
    if node.kind() == "assignment" {
        return Some(node);
    }
    if node.kind() != "expression_statement" {
        return None;
    }
    named_children(node)
        .into_iter()
        .find(|child| child.kind() == "assignment")
}

fn class_bases(node: Node<'_>, source_text: &str) -> Vec<String> {
    let Some(superclasses) = node.child_by_field_name("superclasses") else {
        return Vec::new();
    };
    named_children(superclasses)
        .into_iter()
        .filter_map(|child| expression_name(child, source_text))
        .collect()
}

fn is_test_class(name: &str, bases: &[String]) -> bool {
    name.starts_with("Test") || bases.iter().any(|base| base == "unittest.TestCase")
}

fn is_test_function(path: &str, name: &str, in_test_class: bool) -> bool {
    (is_test_file(path) && name.starts_with("test_")) || in_test_class && name.starts_with("test_")
}

fn is_test_file(path: &str) -> bool {
    let file_name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path);
    file_name.starts_with("test_") || file_name.ends_with("_test.py")
}

fn parse_import_statement(text: &str) -> Vec<ImportFact> {
    let Some(imports) = text.trim().strip_prefix("import ") else {
        return Vec::new();
    };
    imports
        .split(',')
        .filter_map(|entry| parse_import_entry(entry.trim()))
        .map(|(specifier, local)| ImportFact {
            specifier,
            bindings: vec![ImportBinding {
                local,
                imported: "*".to_string(),
            }],
        })
        .collect()
}

fn parse_import_entry(entry: &str) -> Option<(String, String)> {
    let (module, alias) = split_alias(entry);
    if module.is_empty() {
        return None;
    }
    let local = alias
        .map(ToString::to_string)
        .or_else(|| module.split('.').next().map(ToString::to_string))?;
    Some((module.to_string(), local))
}

fn parse_from_import_statement(text: &str) -> Vec<ImportFact> {
    let text = text.trim();
    let Some(rest) = text.strip_prefix("from ") else {
        return Vec::new();
    };
    let Some((module, imports)) = rest.split_once(" import ") else {
        return Vec::new();
    };
    let module = module.trim();
    let imports = imports.trim().trim_start_matches('(').trim_end_matches(')');
    if imports == "*" {
        return vec![ImportFact {
            specifier: module.to_string(),
            bindings: vec![ImportBinding {
                local: "*".to_string(),
                imported: "*".to_string(),
            }],
        }];
    }
    imports
        .split(',')
        .filter_map(|entry| parse_from_import_entry(module, entry.trim()))
        .collect()
}

fn parse_from_import_entry(module: &str, entry: &str) -> Option<ImportFact> {
    let (imported, alias) = split_alias(entry);
    if imported.is_empty() {
        return None;
    }
    let local = alias.unwrap_or(imported).to_string();
    let (specifier, imported_name) = if module.chars().all(|character| character == '.') {
        (format!("{module}{imported}"), "*".to_string())
    } else {
        (module.to_string(), imported.to_string())
    };
    Some(ImportFact {
        specifier,
        bindings: vec![ImportBinding {
            local,
            imported: imported_name,
        }],
    })
}

fn split_alias(entry: &str) -> (&str, Option<&str>) {
    if let Some((left, right)) = entry.split_once(" as ") {
        (left.trim(), Some(right.trim()))
    } else {
        (entry.trim(), None)
    }
}

fn decorator_name(node: Node<'_>, source_text: &str) -> Option<String> {
    let text = node_text(node, source_text);
    text.trim()
        .strip_prefix('@')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToString::to_string)
}

fn assignment_name(node: Node<'_>, source_text: &str) -> Option<String> {
    match node.kind() {
        "identifier" => Some(node_text(node, source_text)),
        _ => None,
    }
}

fn expression_name(node: Node<'_>, source_text: &str) -> Option<String> {
    match node.kind() {
        "identifier" => Some(node_text(node, source_text)),
        "attribute" => {
            let object = node
                .child_by_field_name("object")
                .and_then(|object| expression_name(object, source_text))?;
            let attribute = field_text(node, "attribute", source_text)?;
            Some(format!("{object}.{attribute}"))
        }
        "call" => node
            .child_by_field_name("function")
            .and_then(|function| expression_name(function, source_text)),
        "dotted_name" => Some(node_text(node, source_text)),
        _ => named_children(node)
            .into_iter()
            .find_map(|child| expression_name(child, source_text)),
    }
}

fn is_builtin_reference(name: &str) -> bool {
    matches!(
        name,
        "super"
            | "len"
            | "str"
            | "int"
            | "float"
            | "bool"
            | "list"
            | "dict"
            | "set"
            | "tuple"
            | "print"
            | "range"
    ) || name.starts_with("self.")
        || name.starts_with("cls.")
}

fn field_text(node: Node<'_>, field: &str, source_text: &str) -> Option<String> {
    node.child_by_field_name(field)
        .map(|child| node_text(child, source_text))
}

fn node_text(node: Node<'_>, source_text: &str) -> String {
    node.utf8_text(source_text.as_bytes())
        .map(ToString::to_string)
        .unwrap_or_default()
}

fn named_children(node: Node<'_>) -> Vec<Node<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

fn descendant_nodes(node: Node<'_>) -> Vec<Node<'_>> {
    let mut nodes = Vec::new();
    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        nodes.push(current);
        for child in named_children(current) {
            stack.push(child);
        }
    }
    nodes
}

fn parse_string_literal(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let quote_index = trimmed.find(['"', '\''])?;
    let quoted = trimmed.get(quote_index..)?;
    let quote = quoted.chars().next()?;
    let triple = format!("{quote}{quote}{quote}");
    if let Some(body) = quoted
        .strip_prefix(&triple)
        .and_then(|body| body.strip_suffix(&triple))
    {
        return Some(body.to_string());
    }
    quoted
        .strip_prefix(quote)
        .and_then(|body| body.strip_suffix(quote))
        .map(ToString::to_string)
}

fn module_name_for_path(path: &str) -> String {
    let without_extension = path
        .strip_suffix(".py")
        .or_else(|| path.strip_suffix(".pyi"))
        .unwrap_or(path);
    let mut parts = without_extension
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.last().is_some_and(|part| *part == "__init__") {
        parts.pop();
    }
    if parts.is_empty() {
        return "__init__".to_string();
    }
    parts.join(".")
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

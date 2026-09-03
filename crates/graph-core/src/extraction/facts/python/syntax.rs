use super::*;

pub(super) struct ExportPolicy<'a> {
    pub(super) exported: bool,
    pub(super) policy: &'a str,
}

pub(super) struct Syntax;

pub(super) trait PythonSyntax {
    fn export_policy(
        name: &str,
        is_top_level: bool,
        explicit_exports: Option<&BTreeSet<String>>,
    ) -> ExportPolicy<'static>;
    fn collect_explicit_exports(root: Node<'_>, source_text: &str) -> Option<BTreeSet<String>>;
    fn module_level_assignment(node: Node<'_>) -> Option<Node<'_>>;
    fn class_bases(node: Node<'_>, source_text: &str) -> Vec<String>;
    fn is_test_class(name: &str, bases: &[String]) -> bool;
    fn is_test_function(path: &str, name: &str, in_test_class: bool) -> bool;
    fn is_test_file(path: &str) -> bool;
    fn parse_import_statement(text: &str) -> Vec<ImportFact>;
    fn parse_import_entry(entry: &str) -> Option<(String, String)>;
    fn parse_from_import_statement(text: &str) -> Vec<ImportFact>;
    fn parse_from_import_entry(module: &str, entry: &str) -> Option<ImportFact>;
    fn split_alias(entry: &str) -> (&str, Option<&str>);
    fn decorator_name(node: Node<'_>, source_text: &str) -> Option<String>;
    fn assignment_name(node: Node<'_>, source_text: &str) -> Option<String>;
    fn expression_name(node: Node<'_>, source_text: &str) -> Option<String>;
    fn is_builtin_reference(name: &str) -> bool;
    fn field_text(node: Node<'_>, field: &str, source_text: &str) -> Option<String>;
    fn node_text(node: Node<'_>, source_text: &str) -> String;
    fn named_children(node: Node<'_>) -> Vec<Node<'_>>;
    fn descendant_nodes(node: Node<'_>) -> Vec<Node<'_>>;
    fn parse_string_literal(text: &str) -> Option<String>;
    fn module_name_for_path(path: &str) -> String;
}

impl PythonSyntax for Syntax {
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
        for statement in Self::named_children(root) {
            let Some(node) = Self::module_level_assignment(statement) else {
                continue;
            };
            let left = node.child_by_field_name("left");
            if left
                .and_then(|left| Self::assignment_name(left, source_text))
                .as_deref()
                != Some("__all__")
            {
                continue;
            }
            found = true;
            let Some(right) = node.child_by_field_name("right") else {
                continue;
            };
            for string_node in Self::descendant_nodes(right) {
                if string_node.kind() != "string" {
                    continue;
                }
                let Some(value) =
                    Self::parse_string_literal(&Self::node_text(string_node, source_text))
                else {
                    continue;
                };
                exports.insert(value);
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
        Self::named_children(node)
            .into_iter()
            .find(|child| child.kind() == "assignment")
    }

    fn class_bases(node: Node<'_>, source_text: &str) -> Vec<String> {
        let Some(superclasses) = node.child_by_field_name("superclasses") else {
            return Vec::new();
        };
        Self::named_children(superclasses)
            .into_iter()
            .filter_map(|child| Self::expression_name(child, source_text))
            .collect()
    }

    fn is_test_class(name: &str, bases: &[String]) -> bool {
        name.starts_with("Test") || bases.iter().any(|base| base == "unittest.TestCase")
    }

    fn is_test_function(path: &str, name: &str, in_test_class: bool) -> bool {
        (Self::is_test_file(path) && name.starts_with("test_"))
            || in_test_class && name.starts_with("test_")
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
            .filter_map(|entry| Self::parse_import_entry(entry.trim()))
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
        let (module, alias) = Self::split_alias(entry);
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
            .filter_map(|entry| Self::parse_from_import_entry(module, entry.trim()))
            .collect()
    }

    fn parse_from_import_entry(module: &str, entry: &str) -> Option<ImportFact> {
        let (imported, alias) = Self::split_alias(entry);
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
        let text = Self::node_text(node, source_text);
        text.trim()
            .strip_prefix('@')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(ToString::to_string)
    }

    fn assignment_name(node: Node<'_>, source_text: &str) -> Option<String> {
        match node.kind() {
            "identifier" => Some(Self::node_text(node, source_text)),
            _ => None,
        }
    }

    fn expression_name(node: Node<'_>, source_text: &str) -> Option<String> {
        match node.kind() {
            "identifier" => Some(Self::node_text(node, source_text)),
            "attribute" => {
                let object = node
                    .child_by_field_name("object")
                    .and_then(|object| Self::expression_name(object, source_text))?;
                let attribute = Self::field_text(node, "attribute", source_text)?;
                Some(format!("{object}.{attribute}"))
            }
            "call" => node
                .child_by_field_name("function")
                .and_then(|function| Self::expression_name(function, source_text)),
            "dotted_name" => Some(Self::node_text(node, source_text)),
            _ => Self::named_children(node)
                .into_iter()
                .find_map(|child| Self::expression_name(child, source_text)),
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
            .map(|child| Self::node_text(child, source_text))
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
            for child in Self::named_children(current) {
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
}

use tree_sitter::Node;

use crate::{
    analysis::{AnalysisError, sort_and_dedup},
    cancel::CancelToken,
    identity::hash_domain,
    limits::{MAX_DEPENDENCY_FACTS_PER_FILE, MAX_INTERFACE_FACTS_PER_FILE},
    model::{
        DependencyExtractionStatus, DependencyFacts, DependencyReference, DependencyReferenceKind,
        InterfaceDeclarationKind, InterfaceExportFact, InterfaceExportNamespace,
        InterfaceExportOrigin, InterfaceExtractionStatus, InterfaceFacts, InterfaceGapCounts,
        InterfaceImportFact, InterfaceImportRole, InterfaceNamespace, InterfaceSelector,
        InterfaceSelectorKind, InterfaceShapeFact, InterfaceShapeKind, InterfaceSurfaceStatus,
    },
};

use super::{
    input::GoToken,
    node_text,
    walk::{self, WalkEvent},
};

pub(super) fn extract(
    root: Node<'_>,
    source: &[u8],
    tokens: &[GoToken],
    cancel: &CancelToken,
) -> Result<(DependencyFacts, InterfaceFacts), AnalysisError> {
    let mut collector = ModuleCollector::default();
    let mut cursor = root.walk();
    for node in root.named_children(&mut cursor) {
        collector.observe_top_level(node, source, tokens, cancel)?;
    }
    Ok(collector.finish())
}

pub(super) fn complete_dependencies(references: Vec<DependencyReference>) -> DependencyFacts {
    DependencyFacts {
        status: DependencyExtractionStatus::Complete,
        references,
    }
}

pub(super) fn complete_interfaces() -> InterfaceFacts {
    InterfaceFacts {
        status: InterfaceExtractionStatus::Complete,
        public_surface_status: InterfaceSurfaceStatus::Complete,
        ..InterfaceFacts::default()
    }
}

pub(super) fn conditional_facts() -> (DependencyFacts, InterfaceFacts) {
    (
        complete_dependencies(vec![DependencyReference {
            kind: DependencyReferenceKind::GoUnsupportedConditional,
            specifier: "build_constraint".into(),
            level: 0,
        }]),
        InterfaceFacts {
            status: InterfaceExtractionStatus::Partial,
            public_surface_status: InterfaceSurfaceStatus::Partial,
            gaps: InterfaceGapCounts {
                unsupported_patterns: 1,
                ..InterfaceGapCounts::default()
            },
            ..InterfaceFacts::default()
        },
    )
}

#[derive(Default)]
struct ModuleCollector {
    dependencies: Vec<DependencyReference>,
    imports: Vec<InterfaceImportFact>,
    exports: Vec<InterfaceExportFact>,
    shapes: Vec<InterfaceShapeFact>,
    gaps: InterfaceGapCounts,
    dependency_truncated: bool,
    interface_truncated: bool,
}

impl ModuleCollector {
    fn observe_top_level(
        &mut self,
        node: Node<'_>,
        source: &[u8],
        tokens: &[GoToken],
        cancel: &CancelToken,
    ) -> Result<(), AnalysisError> {
        match node.kind() {
            "import_declaration" => self.observe_import_declaration(node, source, cancel),
            "function_declaration" => {
                self.observe_function(node, source);
                Ok(())
            }
            "method_declaration" => {
                self.observe_method(node, source);
                Ok(())
            }
            "type_declaration" => self.observe_type_declaration(node, source, tokens, cancel),
            "const_declaration" => self.observe_values(
                node,
                source,
                "const_spec",
                InterfaceDeclarationKind::Constant,
                cancel,
            ),
            "var_declaration" => self.observe_values(
                node,
                source,
                "var_spec",
                InterfaceDeclarationKind::Variable,
                cancel,
            ),
            _ => Ok(()),
        }
    }

    fn observe_import_declaration(
        &mut self,
        declaration: Node<'_>,
        source: &[u8],
        cancel: &CancelToken,
    ) -> Result<(), AnalysisError> {
        visit_matching(
            declaration,
            cancel,
            |node| node.kind() == "import_spec",
            |node| self.observe_import(node, source),
        )
    }

    fn observe_import(&mut self, spec: Node<'_>, source: &[u8]) {
        let path = spec
            .child_by_field_name("path")
            .and_then(|node| node_text(node, source))
            .and_then(unquote_go_string);
        let Some(path) = path else {
            self.push_dependency(DependencyReference {
                kind: DependencyReferenceKind::GoUnsupportedImport,
                specifier: "invalid_import_path".into(),
                level: 0,
            });
            self.gaps.unsupported_patterns = self.gaps.unsupported_patterns.saturating_add(1);
            return;
        };
        self.push_dependency(DependencyReference {
            kind: DependencyReferenceKind::GoImport,
            specifier: path.clone(),
            level: 0,
        });
        let selector = self.import_selector(spec, source);
        self.push_import(InterfaceImportFact {
            specifier: path,
            level: 0,
            role: InterfaceImportRole::Import,
            namespace: InterfaceNamespace::Runtime,
            selector,
        });
    }

    fn import_selector(&mut self, spec: Node<'_>, source: &[u8]) -> InterfaceSelector {
        spec.child_by_field_name("name").map_or(
            InterfaceSelector {
                kind: InterfaceSelectorKind::Namespace,
                name: String::new(),
            },
            |name| self.named_import_selector(name, source),
        )
    }

    fn named_import_selector(&mut self, name: Node<'_>, source: &[u8]) -> InterfaceSelector {
        match name.kind() {
            "blank_identifier" => InterfaceSelector {
                kind: InterfaceSelectorKind::SideEffect,
                name: String::new(),
            },
            "dot" => {
                self.gaps.unsupported_patterns = self.gaps.unsupported_patterns.saturating_add(1);
                InterfaceSelector {
                    kind: InterfaceSelectorKind::Namespace,
                    name: ".".into(),
                }
            }
            _ => InterfaceSelector {
                kind: InterfaceSelectorKind::Namespace,
                name: node_text(name, source).unwrap_or_default().into(),
            },
        }
    }

    fn observe_function(&mut self, node: Node<'_>, source: &[u8]) {
        if let Some(name) = declaration_name(node, source).filter(|name| exported(name)) {
            self.push_export(export_fact(name, InterfaceDeclarationKind::Function));
        }
    }

    fn observe_method(&mut self, node: Node<'_>, source: &[u8]) {
        let Some(name) = declaration_name(node, source).filter(|name| exported(name)) else {
            return;
        };
        let receiver = node
            .child_by_field_name("receiver")
            .and_then(|item| receiver_type_name(item, source))
            .unwrap_or_else(|| "<receiver>".into());
        self.push_export(export_fact(
            &format!("{receiver}.{name}"),
            InterfaceDeclarationKind::Method,
        ));
    }

    fn observe_type_declaration(
        &mut self,
        declaration: Node<'_>,
        source: &[u8],
        tokens: &[GoToken],
        cancel: &CancelToken,
    ) -> Result<(), AnalysisError> {
        visit_matching(
            declaration,
            cancel,
            |node| matches!(node.kind(), "type_spec" | "type_alias"),
            |node| self.observe_type(node, source, tokens),
        )
    }

    fn observe_type(&mut self, node: Node<'_>, source: &[u8], tokens: &[GoToken]) {
        let Some(name) = declaration_name(node, source).filter(|name| exported(name)) else {
            return;
        };
        let value = node.child_by_field_name("type");
        self.push_export(export_fact(name, declaration_kind(value)));
        if let (Some(shape_kind), Some(value)) = (shape_kind(value), value) {
            self.push_shape(InterfaceShapeFact {
                exported_name: name.into(),
                kind: shape_kind,
                member_count: direct_shape_members(value),
                fingerprint: shape_fingerprint(value, tokens, source),
            });
        }
    }

    fn observe_values(
        &mut self,
        declaration: Node<'_>,
        source: &[u8],
        spec_kind: &str,
        kind: InterfaceDeclarationKind,
        cancel: &CancelToken,
    ) -> Result<(), AnalysisError> {
        visit_matching(
            declaration,
            cancel,
            |node| node.kind() == spec_kind,
            |node| self.observe_value_names(node, source, kind),
        )
    }

    fn observe_value_names(
        &mut self,
        node: Node<'_>,
        source: &[u8],
        kind: InterfaceDeclarationKind,
    ) {
        let mut cursor = node.walk();
        for name in node.children_by_field_name("name", &mut cursor) {
            if let Some(name) = node_text(name, source).filter(|name| exported(name)) {
                self.push_export(export_fact(name, kind));
            }
        }
    }

    fn push_dependency(&mut self, fact: DependencyReference) {
        if self.dependencies.len() >= MAX_DEPENDENCY_FACTS_PER_FILE {
            self.dependency_truncated = true;
        } else {
            self.dependencies.push(fact);
        }
    }

    fn push_import(&mut self, fact: InterfaceImportFact) {
        if self.interface_count() >= MAX_INTERFACE_FACTS_PER_FILE {
            self.interface_truncated = true;
        } else {
            self.imports.push(fact);
        }
    }

    fn push_export(&mut self, fact: InterfaceExportFact) {
        if self.interface_count() >= MAX_INTERFACE_FACTS_PER_FILE {
            self.interface_truncated = true;
        } else {
            self.exports.push(fact);
        }
    }

    fn push_shape(&mut self, fact: InterfaceShapeFact) {
        if self.interface_count() >= MAX_INTERFACE_FACTS_PER_FILE {
            self.interface_truncated = true;
        } else {
            self.shapes.push(fact);
        }
    }

    fn interface_count(&self) -> usize {
        self.imports
            .len()
            .saturating_add(self.exports.len())
            .saturating_add(self.shapes.len())
    }

    fn finish(mut self) -> (DependencyFacts, InterfaceFacts) {
        sort_and_dedup(&mut self.dependencies);
        sort_and_dedup(&mut self.imports);
        sort_and_dedup(&mut self.exports);
        sort_and_dedup(&mut self.shapes);
        let has_gaps = self.gaps.unsupported_patterns > 0;
        (
            DependencyFacts {
                status: dependency_status(self.dependency_truncated),
                references: self.dependencies,
            },
            InterfaceFacts {
                status: interface_status(self.interface_truncated, has_gaps),
                public_surface_status: surface_status(self.interface_truncated),
                imports: self.imports,
                exports: self.exports,
                shapes: self.shapes,
                gaps: self.gaps,
            },
        )
    }
}

fn visit_matching<'tree>(
    root: Node<'tree>,
    cancel: &CancelToken,
    mut matches: impl FnMut(Node<'tree>) -> bool,
    mut observe: impl FnMut(Node<'tree>),
) -> Result<(), AnalysisError> {
    walk::walk(root, cancel, |event| {
        let WalkEvent::Enter(node) = event else {
            return Ok(true);
        };
        if matches(node) {
            observe(node);
            Ok(false)
        } else {
            Ok(true)
        }
    })
}

fn dependency_status(truncated: bool) -> DependencyExtractionStatus {
    if truncated {
        DependencyExtractionStatus::Truncated
    } else {
        DependencyExtractionStatus::Complete
    }
}

fn interface_status(truncated: bool, gaps: bool) -> InterfaceExtractionStatus {
    if truncated {
        InterfaceExtractionStatus::Truncated
    } else if gaps {
        InterfaceExtractionStatus::Partial
    } else {
        InterfaceExtractionStatus::Complete
    }
}

fn surface_status(truncated: bool) -> InterfaceSurfaceStatus {
    if truncated {
        InterfaceSurfaceStatus::Truncated
    } else {
        InterfaceSurfaceStatus::Complete
    }
}

fn declaration_name<'a>(node: Node<'_>, source: &'a [u8]) -> Option<&'a str> {
    node.child_by_field_name("name")
        .and_then(|item| node_text(item, source))
}

fn declaration_kind(value: Option<Node<'_>>) -> InterfaceDeclarationKind {
    match value.map(|item| item.kind()) {
        Some("struct_type") => InterfaceDeclarationKind::Struct,
        Some("interface_type") => InterfaceDeclarationKind::Interface,
        _ => InterfaceDeclarationKind::TypeAlias,
    }
}

fn shape_kind(value: Option<Node<'_>>) -> Option<InterfaceShapeKind> {
    match value.map(|item| item.kind()) {
        Some("struct_type") => Some(InterfaceShapeKind::Struct),
        Some("interface_type") => Some(InterfaceShapeKind::Interface),
        _ => None,
    }
}

fn export_fact(name: &str, kind: InterfaceDeclarationKind) -> InterfaceExportFact {
    InterfaceExportFact {
        exported_name: name.into(),
        namespace: InterfaceExportNamespace::Value,
        origin: InterfaceExportOrigin::Local,
        declaration_kind: kind,
    }
}

fn exported(name: &str) -> bool {
    name.chars().next().is_some_and(char::is_uppercase)
}

pub(super) fn receiver_type_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    let mut result = None;
    walk::walk_without_cancel(node, |item| {
        if result.is_none() && item.kind() == "type_identifier" {
            result = node_text(item, source).map(str::to_owned);
            false
        } else {
            true
        }
    });
    result
}

fn direct_shape_members(node: Node<'_>) -> usize {
    let child_kind = if node.kind() == "struct_type" {
        "field_declaration"
    } else {
        "method_elem"
    };
    let mut count = 0usize;
    walk::walk_without_cancel(node, |item| {
        let member = item.kind() == child_kind
            || (node.kind() == "interface_type" && item.kind() == "type_elem");
        if member {
            count = count.saturating_add(1);
        }
        !member
    });
    count
}

fn shape_fingerprint(node: Node<'_>, tokens: &[GoToken], source: &[u8]) -> String {
    let mut encoded = Vec::new();
    for token in tokens.iter().filter(|token| inside_shape(token, node)) {
        let text = source.get(token.start..token.end).unwrap_or_default();
        encoded.extend_from_slice(&u32::try_from(text.len()).unwrap_or(u32::MAX).to_be_bytes());
        encoded.extend_from_slice(text);
    }
    hex::encode(hash_domain("go-interface-shape/v1", &[&encoded]))
}

fn inside_shape(token: &GoToken, node: Node<'_>) -> bool {
    token.counted && token.start >= node.start_byte() && token.end <= node.end_byte()
}

fn unquote_go_string(value: &str) -> Option<String> {
    if let Some(raw) = value
        .strip_prefix('`')
        .and_then(|item| item.strip_suffix('`'))
    {
        return Some(raw.replace('\r', ""));
    }
    let body = value.strip_prefix('"')?.strip_suffix('"')?;
    decode_interpreted_string(body)
}

fn decode_interpreted_string(body: &str) -> Option<String> {
    let mut result = String::new();
    let mut chars = body.chars();
    while let Some(character) = chars.next() {
        if character == '\\' {
            result.push(decode_escape(&mut chars)?);
        } else {
            result.push(character);
        }
    }
    Some(result)
}

fn decode_escape(chars: &mut impl Iterator<Item = char>) -> Option<char> {
    let escaped = chars.next()?;
    if let Some(simple) = simple_escape(escaped) {
        return Some(simple);
    }
    match escaped {
        'x' => decode_digits(chars, 2),
        'u' => decode_digits(chars, 4),
        'U' => decode_digits(chars, 8),
        digit if matches!(digit, '0'..='7') => decode_octal(chars, digit),
        _ => None,
    }
}

fn decode_digits(chars: &mut impl Iterator<Item = char>, count: usize) -> Option<char> {
    char::from_u32(read_digits(chars, count, 16)?)
}

fn simple_escape(value: char) -> Option<char> {
    const ESCAPES: &[(char, char)] = &[
        ('a', '\u{7}'),
        ('b', '\u{8}'),
        ('f', '\u{c}'),
        ('n', '\n'),
        ('r', '\r'),
        ('t', '\t'),
        ('v', '\u{b}'),
        ('\\', '\\'),
        ('"', '"'),
        ('\'', '\''),
    ];
    ESCAPES
        .iter()
        .find_map(|(escaped, decoded)| (*escaped == value).then_some(*decoded))
}

fn decode_octal(chars: &mut impl Iterator<Item = char>, first: char) -> Option<char> {
    let mut value = first.to_digit(8)?;
    for _ in 0..2 {
        value = value
            .checked_mul(8)?
            .checked_add(chars.next()?.to_digit(8)?)?;
    }
    char::from_u32(value)
}

fn read_digits(chars: &mut impl Iterator<Item = char>, count: usize, radix: u32) -> Option<u32> {
    let mut value = 0u32;
    for _ in 0..count {
        value = value
            .checked_mul(radix)?
            .checked_add(chars.next()?.to_digit(radix)?)?;
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::unquote_go_string;

    #[test]
    fn string_unquoting_is_bounded_and_exact() {
        assert_eq!(
            unquote_go_string(r#""example.com/a\x2fb""#).as_deref(),
            Some("example.com/a/b")
        );
        assert_eq!(
            unquote_go_string("`example.com/raw` ".trim()).as_deref(),
            Some("example.com/raw")
        );
        assert!(unquote_go_string(r#""bad\q""#).is_none());
    }
}

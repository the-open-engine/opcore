use std::collections::BTreeMap;

use oxc_ast::ast::{
    BindingPattern, Declaration, ExportAllDeclaration, ExportDefaultDeclaration,
    ExportDefaultDeclarationKind, ExportNamedDeclaration, ImportDeclaration,
    ImportDeclarationSpecifier, ImportOrExportKind, ModuleExportName, Program, Statement, TSType,
    VariableDeclaration,
};
use oxc_parser::{Kind, ParserReturn};
use oxc_span::Span;

use crate::{
    analysis::sort_and_dedup,
    identity::hash_domain,
    limits::MAX_INTERFACE_FACTS_PER_FILE,
    model::{
        InterfaceDeclarationKind, InterfaceExportFact, InterfaceExportNamespace,
        InterfaceExportOrigin, InterfaceExtractionStatus, InterfaceFacts, InterfaceGapCounts,
        InterfaceImportFact, InterfaceImportRole, InterfaceNamespace, InterfaceSelector,
        InterfaceSelectorKind, InterfaceShapeFact, InterfaceShapeKind, InterfaceSurfaceStatus,
    },
};

use super::LexToken;

#[derive(Clone)]
struct LocalDeclaration {
    kind: InterfaceDeclarationKind,
    namespace: InterfaceExportNamespace,
    shape: Option<LocalShape>,
}

#[derive(Clone)]
struct LocalShape {
    kind: InterfaceShapeKind,
    member_count: usize,
    fingerprint: String,
}

pub(super) fn extract(
    parsed: &ParserReturn<'_>,
    tokens: &[LexToken],
    language_mode: &str,
) -> InterfaceFacts {
    if parsed.panicked || !parsed.diagnostics.is_empty() {
        return InterfaceFacts {
            status: InterfaceExtractionStatus::ParserFailed,
            ..InterfaceFacts::default()
        };
    }
    let (declarations, declarations_truncated, declaration_gaps) =
        local_declarations(&parsed.program, tokens);
    let mut collector = Collector {
        truncated: declarations_truncated,
        gaps: InterfaceGapCounts {
            unsupported_patterns: declaration_gaps,
            ..InterfaceGapCounts::default()
        },
        ..Collector::default()
    };
    for statement in &parsed.program.body {
        collector.observe_statement(statement, &declarations, tokens);
    }
    collector.observe_tokens(tokens, language_mode);
    collector.finish()
}

#[derive(Default)]
struct Collector {
    imports: Vec<InterfaceImportFact>,
    exports: Vec<InterfaceExportFact>,
    shapes: Vec<InterfaceShapeFact>,
    gaps: InterfaceGapCounts,
    truncated: bool,
}

impl Collector {
    fn observe_statement(
        &mut self,
        statement: &Statement<'_>,
        declarations: &BTreeMap<String, LocalDeclaration>,
        tokens: &[LexToken],
    ) {
        match statement {
            Statement::ImportDeclaration(declaration) => self.observe_import(declaration),
            Statement::ExportNamedDeclaration(declaration) => {
                self.observe_named_export(declaration, declarations, tokens);
            }
            Statement::ExportAllDeclaration(declaration) => self.observe_export_all(declaration),
            Statement::ExportDefaultDeclaration(declaration) => {
                self.observe_default_export(declaration, tokens);
            }
            _ => {}
        }
    }

    fn observe_named_export(
        &mut self,
        declaration: &ExportNamedDeclaration<'_>,
        declarations: &BTreeMap<String, LocalDeclaration>,
        tokens: &[LexToken],
    ) {
        if let Some(source) = &declaration.source {
            self.observe_re_exports(declaration, source.value.as_str());
            return;
        }
        if let Some(exported_declaration) = &declaration.declaration {
            self.observe_exported_declaration(exported_declaration, tokens);
        }
        for specifier in &declaration.specifiers {
            let local = module_export_name(&specifier.local);
            let exported = module_export_name(&specifier.exported);
            let known = declarations.get(&local);
            let namespace = if declaration.export_kind == ImportOrExportKind::Type
                || specifier.export_kind == ImportOrExportKind::Type
            {
                InterfaceExportNamespace::TypeOnly
            } else {
                known.map_or(InterfaceExportNamespace::Value, |item| item.namespace)
            };
            self.push_export(InterfaceExportFact {
                exported_name: exported.clone(),
                namespace,
                origin: InterfaceExportOrigin::Local,
                declaration_kind: known.map_or(InterfaceDeclarationKind::Unknown, |item| item.kind),
            });
            if let Some(shape) = known.and_then(|item| item.shape.as_ref()) {
                self.push_shape(InterfaceShapeFact {
                    exported_name: exported,
                    kind: shape.kind,
                    member_count: shape.member_count,
                    fingerprint: shape.fingerprint.clone(),
                });
            }
        }
    }

    fn observe_re_exports(&mut self, declaration: &ExportNamedDeclaration<'_>, source: &str) {
        for specifier in &declaration.specifiers {
            let namespace = namespace_for_kind(declaration.export_kind, specifier.export_kind);
            self.push_import(InterfaceImportFact {
                specifier: source.to_owned(),
                level: 0,
                role: InterfaceImportRole::ReExport,
                namespace: import_namespace(namespace),
                selector: named_or_default(module_export_name(&specifier.local)),
            });
            self.push_export(InterfaceExportFact {
                exported_name: module_export_name(&specifier.exported),
                namespace,
                origin: InterfaceExportOrigin::ReExport,
                declaration_kind: InterfaceDeclarationKind::Unknown,
            });
        }
    }

    fn observe_export_all(&mut self, declaration: &ExportAllDeclaration<'_>) {
        let namespace = export_namespace(declaration.export_kind);
        self.push_import(InterfaceImportFact {
            specifier: declaration.source.value.to_string(),
            level: 0,
            role: InterfaceImportRole::ReExport,
            namespace: import_namespace(namespace),
            selector: InterfaceSelector {
                kind: InterfaceSelectorKind::Namespace,
                name: String::new(),
            },
        });
        self.gaps.wildcard_exports = self.gaps.wildcard_exports.saturating_add(1);
        if let Some(exported) = &declaration.exported {
            self.push_export(InterfaceExportFact {
                exported_name: module_export_name(exported),
                namespace: InterfaceExportNamespace::Namespace,
                origin: InterfaceExportOrigin::ReExport,
                declaration_kind: InterfaceDeclarationKind::Unknown,
            });
        }
    }

    fn observe_default_export(
        &mut self,
        declaration: &ExportDefaultDeclaration<'_>,
        tokens: &[LexToken],
    ) {
        let (kind, namespace, shape) = default_export(declaration, tokens);
        self.push_export(InterfaceExportFact {
            exported_name: "default".into(),
            namespace,
            origin: InterfaceExportOrigin::Local,
            declaration_kind: kind,
        });
        if let Some(shape) = shape {
            self.push_shape(InterfaceShapeFact {
                exported_name: "default".into(),
                kind: shape.kind,
                member_count: shape.member_count,
                fingerprint: shape.fingerprint,
            });
        }
    }

    fn observe_import(&mut self, declaration: &ImportDeclaration<'_>) {
        let specifier = declaration.source.value.to_string();
        let Some(specifiers) = declaration
            .specifiers
            .as_ref()
            .filter(|specifiers| !specifiers.is_empty())
        else {
            self.push_import(InterfaceImportFact {
                specifier,
                level: 0,
                role: InterfaceImportRole::Import,
                namespace: InterfaceNamespace::Runtime,
                selector: InterfaceSelector {
                    kind: InterfaceSelectorKind::SideEffect,
                    name: String::new(),
                },
            });
            return;
        };
        for item in specifiers {
            let (namespace, selector) = self.import_specifier(declaration.import_kind, item);
            self.push_import(InterfaceImportFact {
                specifier: specifier.clone(),
                level: 0,
                role: InterfaceImportRole::Import,
                namespace,
                selector,
            });
        }
    }

    fn import_specifier(
        &mut self,
        declaration_kind: ImportOrExportKind,
        item: &ImportDeclarationSpecifier<'_>,
    ) -> (InterfaceNamespace, InterfaceSelector) {
        let type_only = declaration_kind == ImportOrExportKind::Type;
        match item {
            ImportDeclarationSpecifier::ImportSpecifier(item) => (
                if type_only || item.import_kind == ImportOrExportKind::Type {
                    InterfaceNamespace::TypeOnly
                } else {
                    InterfaceNamespace::Runtime
                },
                named_or_default(module_export_name(&item.imported)),
            ),
            ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => (
                interface_namespace(type_only),
                InterfaceSelector {
                    kind: InterfaceSelectorKind::Default,
                    name: String::new(),
                },
            ),
            ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => {
                self.gaps.namespace_imports = self.gaps.namespace_imports.saturating_add(1);
                (
                    interface_namespace(type_only),
                    InterfaceSelector {
                        kind: InterfaceSelectorKind::Namespace,
                        name: String::new(),
                    },
                )
            }
        }
    }

    fn observe_exported_declaration(&mut self, declaration: &Declaration<'_>, tokens: &[LexToken]) {
        if unsupported_declaration(declaration) {
            self.gaps.unsupported_patterns = self.gaps.unsupported_patterns.saturating_add(1);
        }
        let (items, truncated) = declaration_items(declaration, tokens);
        self.truncated |= truncated;
        for (name, item) in items {
            self.push_export(InterfaceExportFact {
                exported_name: name.clone(),
                namespace: item.namespace,
                origin: InterfaceExportOrigin::Local,
                declaration_kind: item.kind,
            });
            if let Some(shape) = item.shape {
                self.push_shape(InterfaceShapeFact {
                    exported_name: name,
                    kind: shape.kind,
                    member_count: shape.member_count,
                    fingerprint: shape.fingerprint,
                });
            }
        }
    }

    fn observe_tokens(&mut self, tokens: &[LexToken], language_mode: &str) {
        let dynamic = tokens
            .windows(2)
            .filter(|pair| {
                (pair[0].kind == Kind::Import || pair[0].text == "require")
                    && pair[1].kind == Kind::LParen
            })
            .count();
        self.gaps.dynamic_loaders = self.gaps.dynamic_loaders.saturating_add(dynamic);
        let common_js = tokens
            .windows(3)
            .filter(|items| {
                (items[0].text == "module"
                    && items[1].kind == Kind::Dot
                    && items[2].text == "exports")
                    || (items[0].text == "exports" && items[1].kind == Kind::Dot)
            })
            .count();
        self.gaps.common_js_exports = self.gaps.common_js_exports.saturating_add(common_js);
        if language_mode.contains("commonjs") && common_js == 0 {
            self.gaps.unsupported_patterns = self.gaps.unsupported_patterns.saturating_add(1);
        }
    }

    fn push_import(&mut self, fact: InterfaceImportFact) {
        if self.fact_count() >= MAX_INTERFACE_FACTS_PER_FILE {
            self.truncated = true;
        } else {
            self.imports.push(fact);
        }
    }

    fn push_export(&mut self, fact: InterfaceExportFact) {
        if self.fact_count() >= MAX_INTERFACE_FACTS_PER_FILE {
            self.truncated = true;
        } else {
            self.exports.push(fact);
        }
    }

    fn push_shape(&mut self, fact: InterfaceShapeFact) {
        if self.fact_count() >= MAX_INTERFACE_FACTS_PER_FILE {
            self.truncated = true;
        } else {
            self.shapes.push(fact);
        }
    }

    fn fact_count(&self) -> usize {
        self.imports
            .len()
            .saturating_add(self.exports.len())
            .saturating_add(self.shapes.len())
    }

    fn finish(mut self) -> InterfaceFacts {
        sort_and_dedup(&mut self.imports);
        sort_and_dedup(&mut self.exports);
        sort_and_dedup(&mut self.shapes);
        let status = if self.truncated {
            InterfaceExtractionStatus::Truncated
        } else if has_gaps(&self.gaps) {
            InterfaceExtractionStatus::Partial
        } else {
            InterfaceExtractionStatus::Complete
        };
        InterfaceFacts {
            status,
            public_surface_status: if self.truncated {
                InterfaceSurfaceStatus::Truncated
            } else if self.gaps.wildcard_exports > 0
                || self.gaps.common_js_exports > 0
                || self.gaps.unsupported_patterns > 0
            {
                InterfaceSurfaceStatus::Partial
            } else {
                InterfaceSurfaceStatus::Complete
            },
            imports: self.imports,
            exports: self.exports,
            shapes: self.shapes,
            gaps: self.gaps,
        }
    }
}

fn local_declarations(
    program: &Program<'_>,
    tokens: &[LexToken],
) -> (BTreeMap<String, LocalDeclaration>, bool, usize) {
    let mut declarations = BTreeMap::new();
    let mut truncated = false;
    let mut gaps = 0usize;
    for statement in &program.body {
        if let Some(declaration) = statement.as_declaration() {
            gaps = gaps.saturating_add(usize::from(unsupported_declaration(declaration)));
            let (items, items_truncated) = declaration_items(declaration, tokens);
            truncated |= items_truncated;
            for (name, item) in items {
                if declarations.len() >= MAX_INTERFACE_FACTS_PER_FILE {
                    truncated = true;
                    break;
                }
                declarations.insert(name, item);
            }
        }
        if let Statement::ExportNamedDeclaration(export) = statement
            && let Some(declaration) = &export.declaration
        {
            gaps = gaps.saturating_add(usize::from(unsupported_declaration(declaration)));
            let (items, items_truncated) = declaration_items(declaration, tokens);
            truncated |= items_truncated;
            for (name, item) in items {
                if declarations.len() >= MAX_INTERFACE_FACTS_PER_FILE {
                    truncated = true;
                    break;
                }
                declarations.insert(name, item);
            }
        }
    }
    (declarations, truncated, gaps)
}

fn declaration_items(
    declaration: &Declaration<'_>,
    tokens: &[LexToken],
) -> (Vec<(String, LocalDeclaration)>, bool) {
    let one = |name: String,
               kind: InterfaceDeclarationKind,
               namespace: InterfaceExportNamespace,
               shape| {
        (
            vec![(
                name,
                LocalDeclaration {
                    kind,
                    namespace,
                    shape,
                },
            )],
            false,
        )
    };
    match declaration {
        Declaration::FunctionDeclaration(item) => item.id.as_ref().map_or_else(
            || (Vec::new(), false),
            |id| {
                one(
                    id.name.to_string(),
                    InterfaceDeclarationKind::Function,
                    InterfaceExportNamespace::Value,
                    None,
                )
            },
        ),
        Declaration::ClassDeclaration(item) => item.id.as_ref().map_or_else(
            || (Vec::new(), false),
            |id| {
                one(
                    id.name.to_string(),
                    InterfaceDeclarationKind::Class,
                    InterfaceExportNamespace::Value,
                    None,
                )
            },
        ),
        Declaration::VariableDeclaration(item) => variable_declaration_items(item),
        Declaration::TSInterfaceDeclaration(item) => one(
            item.id.name.to_string(),
            InterfaceDeclarationKind::Interface,
            InterfaceExportNamespace::TypeOnly,
            Some(local_shape(
                InterfaceShapeKind::Interface,
                item.body.body.len(),
                item.span,
                tokens,
            )),
        ),
        Declaration::TSTypeAliasDeclaration(item) => one(
            item.id.name.to_string(),
            InterfaceDeclarationKind::TypeAlias,
            InterfaceExportNamespace::TypeOnly,
            match &item.type_annotation {
                TSType::TSTypeLiteral(literal) => Some(local_shape(
                    InterfaceShapeKind::TypeLiteralAlias,
                    literal.members.len(),
                    item.span,
                    tokens,
                )),
                _ => None,
            },
        ),
        Declaration::TSEnumDeclaration(item) => one(
            item.id.name.to_string(),
            InterfaceDeclarationKind::Enum,
            InterfaceExportNamespace::Value,
            None,
        ),
        Declaration::TSModuleDeclaration(_)
        | Declaration::TSGlobalDeclaration(_)
        | Declaration::TSImportEqualsDeclaration(_) => (Vec::new(), false),
    }
}

fn variable_declaration_items(
    declaration: &VariableDeclaration<'_>,
) -> (Vec<(String, LocalDeclaration)>, bool) {
    let mut names = Vec::new();
    let mut truncated = false;
    for declarator in &declaration.declarations {
        binding_names(&declarator.id, &mut names);
        if names.len() >= MAX_INTERFACE_FACTS_PER_FILE {
            truncated = true;
            break;
        }
    }
    let items = names
        .into_iter()
        .map(|name| {
            (
                name,
                LocalDeclaration {
                    kind: InterfaceDeclarationKind::Variable,
                    namespace: InterfaceExportNamespace::Value,
                    shape: None,
                },
            )
        })
        .collect();
    (items, truncated)
}

fn local_shape(
    kind: InterfaceShapeKind,
    member_count: usize,
    span: Span,
    tokens: &[LexToken],
) -> LocalShape {
    let mut encoded = Vec::new();
    for token in tokens.iter().filter(|token| {
        token.start_position.byte >= span.start && token.end_position.byte <= span.end
    }) {
        encoded.extend_from_slice(
            &u32::try_from(token.text.len())
                .unwrap_or(u32::MAX)
                .to_be_bytes(),
        );
        encoded.extend_from_slice(token.text.as_bytes());
    }
    LocalShape {
        kind,
        member_count,
        fingerprint: hex::encode(hash_domain("node-interface-shape/v1", &[&encoded])),
    }
}

fn default_export(
    declaration: &ExportDefaultDeclaration<'_>,
    tokens: &[LexToken],
) -> (
    InterfaceDeclarationKind,
    InterfaceExportNamespace,
    Option<LocalShape>,
) {
    match &declaration.declaration {
        ExportDefaultDeclarationKind::FunctionDeclaration(_) => (
            InterfaceDeclarationKind::Function,
            InterfaceExportNamespace::Value,
            None,
        ),
        ExportDefaultDeclarationKind::ClassDeclaration(_) => (
            InterfaceDeclarationKind::Class,
            InterfaceExportNamespace::Value,
            None,
        ),
        ExportDefaultDeclarationKind::TSInterfaceDeclaration(interface) => (
            InterfaceDeclarationKind::Interface,
            InterfaceExportNamespace::TypeOnly,
            Some(local_shape(
                InterfaceShapeKind::Interface,
                interface.body.body.len(),
                interface.span,
                tokens,
            )),
        ),
        _ => (
            InterfaceDeclarationKind::DefaultExpression,
            InterfaceExportNamespace::Value,
            None,
        ),
    }
}

fn binding_names(pattern: &BindingPattern<'_>, names: &mut Vec<String>) {
    if names.len() >= MAX_INTERFACE_FACTS_PER_FILE {
        return;
    }
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => names.push(identifier.name.to_string()),
        BindingPattern::ObjectPattern(pattern) => {
            for property in &pattern.properties {
                binding_names(&property.value, names);
            }
            if let Some(rest) = &pattern.rest {
                binding_names(&rest.argument, names);
            }
        }
        BindingPattern::ArrayPattern(pattern) => {
            for item in pattern.elements.iter().flatten() {
                binding_names(item, names);
            }
            if let Some(rest) = &pattern.rest {
                binding_names(&rest.argument, names);
            }
        }
        BindingPattern::AssignmentPattern(pattern) => binding_names(&pattern.left, names),
    }
}

const fn unsupported_declaration(declaration: &Declaration<'_>) -> bool {
    matches!(
        declaration,
        Declaration::TSModuleDeclaration(_)
            | Declaration::TSGlobalDeclaration(_)
            | Declaration::TSImportEqualsDeclaration(_)
    )
}

fn namespace_for_kind(
    declaration: ImportOrExportKind,
    specifier: ImportOrExportKind,
) -> InterfaceExportNamespace {
    if declaration == ImportOrExportKind::Type || specifier == ImportOrExportKind::Type {
        InterfaceExportNamespace::TypeOnly
    } else {
        InterfaceExportNamespace::Value
    }
}

const fn export_namespace(kind: ImportOrExportKind) -> InterfaceExportNamespace {
    match kind {
        ImportOrExportKind::Value => InterfaceExportNamespace::Value,
        ImportOrExportKind::Type => InterfaceExportNamespace::TypeOnly,
    }
}

const fn import_namespace(namespace: InterfaceExportNamespace) -> InterfaceNamespace {
    match namespace {
        InterfaceExportNamespace::TypeOnly => InterfaceNamespace::TypeOnly,
        InterfaceExportNamespace::Value | InterfaceExportNamespace::Namespace => {
            InterfaceNamespace::Runtime
        }
    }
}

const fn interface_namespace(type_only: bool) -> InterfaceNamespace {
    if type_only {
        InterfaceNamespace::TypeOnly
    } else {
        InterfaceNamespace::Runtime
    }
}

fn named_or_default(name: String) -> InterfaceSelector {
    if name == "default" {
        InterfaceSelector {
            kind: InterfaceSelectorKind::Default,
            name: String::new(),
        }
    } else {
        InterfaceSelector {
            kind: InterfaceSelectorKind::Named,
            name,
        }
    }
}

fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(name) => name.name.to_string(),
        ModuleExportName::IdentifierReference(name) => name.name.to_string(),
        ModuleExportName::StringLiteral(name) => name.value.to_string(),
    }
}

const fn has_gaps(gaps: &InterfaceGapCounts) -> bool {
    gaps.wildcard_exports > 0
        || gaps.namespace_imports > 0
        || gaps.common_js_exports > 0
        || gaps.dynamic_loaders > 0
        || gaps.unsupported_patterns > 0
}

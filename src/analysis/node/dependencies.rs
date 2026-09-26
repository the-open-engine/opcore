use std::collections::HashSet;

use oxc_ast::ast::{
    AssignmentExpression, BindingIdentifier, CallExpression, ExportNamedDeclaration, Expression,
    ForStatementLeft, ImportDeclaration, ImportDeclarationSpecifier, ImportOrExportKind,
    SimpleAssignmentTarget, Statement, TSModuleReference, UpdateExpression,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::{Kind, ParserReturn};

use crate::{
    limits::MAX_DEPENDENCY_FACTS_PER_FILE,
    model::{
        DependencyExtractionStatus, DependencyFacts, DependencyReference, DependencyReferenceKind,
        SourceFile,
    },
};

use super::LexToken;

pub(super) fn extract(
    parsed: &ParserReturn<'_>,
    tokens: &[LexToken],
    file: &SourceFile,
) -> DependencyFacts {
    if parsed.panicked || !parsed.diagnostics.is_empty() {
        return crate::analysis::parser_failed_dependencies();
    }
    let mut collector = Collector::default();
    for statement in &parsed.program.body {
        collector.observe_statement(statement);
    }
    collector.observe_require_calls(parsed, file);
    collector.observe_unsupported_loaders(tokens);
    collector.finish()
}

#[derive(Default)]
struct Collector {
    references: Vec<DependencyReference>,
    truncated: bool,
}

impl Collector {
    fn observe_statement(&mut self, statement: &Statement<'_>) {
        match statement {
            Statement::ImportDeclaration(declaration) => self.push(
                import_declaration_kind(declaration),
                declaration.source.value.as_str(),
            ),
            Statement::ExportNamedDeclaration(declaration) => {
                if let Some(source) = &declaration.source {
                    self.push(export_named_kind(declaration), source.value.as_str());
                }
            }
            Statement::ExportAllDeclaration(declaration) => self.push(
                reference_kind(declaration.export_kind),
                declaration.source.value.as_str(),
            ),
            Statement::TSImportEqualsDeclaration(declaration) => {
                if let TSModuleReference::ExternalModuleReference(reference) =
                    &declaration.module_reference
                {
                    self.push(
                        DependencyReferenceKind::NodeUnsupportedDynamic,
                        reference.expression.value.as_str(),
                    );
                }
            }
            _ => {}
        }
    }

    fn observe_require_calls(&mut self, parsed: &ParserReturn<'_>, file: &SourceFile) {
        let remaining = MAX_DEPENDENCY_FACTS_PER_FILE.saturating_sub(self.references.len());
        let mut visitor = RequireVisitor::new(file, remaining);
        visitor.visit_program(&parsed.program);
        self.references.extend(visitor.references);
        self.truncated |= visitor.truncated;
    }

    fn observe_unsupported_loaders(&mut self, tokens: &[LexToken]) {
        for pair in tokens.windows(2) {
            if pair[0].kind == Kind::Import && pair[1].kind == Kind::LParen {
                self.push(DependencyReferenceKind::NodeUnsupportedDynamic, "");
            }
        }
    }

    fn push(&mut self, kind: DependencyReferenceKind, specifier: &str) {
        if self.references.len() >= MAX_DEPENDENCY_FACTS_PER_FILE {
            self.truncated = true;
            return;
        }
        self.references.push(DependencyReference {
            kind,
            specifier: specifier.into(),
            level: 0,
        });
    }

    fn finish(mut self) -> DependencyFacts {
        self.references.sort();
        DependencyFacts {
            status: if self.truncated {
                DependencyExtractionStatus::Truncated
            } else {
                DependencyExtractionStatus::Complete
            },
            references: self.references,
        }
    }
}

struct RequireVisitor<'a> {
    eligible_calls: HashSet<u32>,
    references: Vec<DependencyReference>,
    reference_limit: usize,
    truncated: bool,
    require_overridden: bool,
    common_js_file: bool,
    marker: std::marker::PhantomData<&'a ()>,
}

impl<'a> RequireVisitor<'a> {
    fn new(file: &SourceFile, reference_limit: usize) -> Self {
        Self {
            eligible_calls: HashSet::new(),
            references: Vec::new(),
            reference_limit,
            truncated: false,
            require_overridden: false,
            common_js_file: file
                .path
                .as_utf8()
                .is_some_and(|path| path.as_bytes().ends_with(b".cjs"))
                && file.language_mode.split(':').any(|part| part == "commonjs"),
            marker: std::marker::PhantomData,
        }
    }

    fn observe_top_level_statement(&mut self, statement: &Statement<'a>) {
        match statement {
            Statement::ExpressionStatement(statement) => {
                self.mark_eligible_expression(&statement.expression);
            }
            Statement::VariableDeclaration(declaration) => {
                for declarator in &declaration.declarations {
                    if let Some(initializer) = &declarator.init {
                        self.mark_eligible_expression(initializer);
                    }
                }
            }
            _ => {}
        }
    }

    fn mark_eligible_expression(&mut self, expression: &Expression<'a>) {
        if let Expression::CallExpression(call) = expression {
            self.eligible_calls.insert(call.span.start);
        }
    }

    fn literal_specifier(call: &CallExpression<'a>) -> Option<String> {
        let [argument] = call.arguments.as_slice() else {
            return None;
        };
        match argument {
            oxc_ast::ast::Argument::StringLiteral(literal) => {
                Some(literal.value.as_str().to_owned())
            }
            _ => None,
        }
    }

    fn valid_common_js_specifier(specifier: &str) -> bool {
        (specifier.starts_with("./") || specifier.starts_with("../"))
            && specifier.as_bytes().ends_with(b".cjs")
    }

    fn push(&mut self, kind: DependencyReferenceKind, specifier: String) {
        if self.references.len() >= self.reference_limit {
            self.truncated = true;
            return;
        }
        self.references.push(DependencyReference {
            kind,
            specifier,
            level: 0,
        });
    }
}

impl<'a> Visit<'a> for RequireVisitor<'a> {
    fn visit_program(&mut self, program: &oxc_ast::ast::Program<'a>) {
        for statement in &program.body {
            self.observe_top_level_statement(statement);
        }
        let mut override_visitor = RequireOverrideVisitor::default();
        override_visitor.visit_program(program);
        self.require_overridden = override_visitor.found;
        walk::walk_program(self, program);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if matches!(&call.callee, Expression::Identifier(identifier) if identifier.name == "require")
        {
            let specifier = Self::literal_specifier(call).unwrap_or_default();
            let eligible = self.common_js_file
                && !self.require_overridden
                && self.eligible_calls.contains(&call.span.start)
                && Self::valid_common_js_specifier(&specifier);
            self.push(
                if eligible {
                    DependencyReferenceKind::NodeRuntime
                } else {
                    DependencyReferenceKind::NodeUnsupportedDynamic
                },
                specifier,
            );
            if let Some(type_arguments) = &call.type_arguments {
                self.visit_ts_type_parameter_instantiation(type_arguments);
            }
            self.visit_arguments(&call.arguments);
            return;
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_identifier_reference(&mut self, identifier: &oxc_ast::ast::IdentifierReference<'a>) {
        if identifier.name == "require" {
            self.push(
                DependencyReferenceKind::NodeUnsupportedDynamic,
                String::new(),
            );
        }
        walk::walk_identifier_reference(self, identifier);
    }
}

#[derive(Default)]
struct RequireOverrideVisitor {
    found: bool,
}

impl<'a> Visit<'a> for RequireOverrideVisitor {
    fn visit_binding_identifier(&mut self, identifier: &BindingIdentifier<'a>) {
        self.found |= identifier.name == "require";
        walk::walk_binding_identifier(self, identifier);
    }

    fn visit_assignment_expression(&mut self, expression: &AssignmentExpression<'a>) {
        let mut target = AssignmentTargetRequireVisitor::default();
        target.visit_assignment_target(&expression.left);
        self.found |= target.found;
        walk::walk_assignment_expression(self, expression);
    }

    fn visit_for_statement_left(&mut self, left: &ForStatementLeft<'a>) {
        if let Some(assignment_target) = left.as_assignment_target() {
            let mut target = AssignmentTargetRequireVisitor::default();
            target.visit_assignment_target(assignment_target);
            self.found |= target.found;
        }
        walk::walk_for_statement_left(self, left);
    }

    fn visit_update_expression(&mut self, expression: &UpdateExpression<'a>) {
        self.found |= matches!(
            &expression.argument,
            SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier)
                if identifier.name == "require"
        );
        walk::walk_update_expression(self, expression);
    }
}

#[derive(Default)]
struct AssignmentTargetRequireVisitor {
    found: bool,
}

impl<'a> Visit<'a> for AssignmentTargetRequireVisitor {
    fn visit_simple_assignment_target(&mut self, target: &SimpleAssignmentTarget<'a>) {
        self.found |= matches!(
            target,
            SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier)
                if identifier.name == "require"
        );
    }

    fn visit_assignment_target_rest(&mut self, rest: &oxc_ast::ast::AssignmentTargetRest<'a>) {
        self.visit_assignment_target(&rest.target);
    }

    fn visit_assignment_target_with_default(
        &mut self,
        target: &oxc_ast::ast::AssignmentTargetWithDefault<'a>,
    ) {
        self.visit_assignment_target(&target.binding);
    }

    fn visit_assignment_target_property_identifier(
        &mut self,
        property: &oxc_ast::ast::AssignmentTargetPropertyIdentifier<'a>,
    ) {
        self.found |= property.binding.name == "require";
    }

    fn visit_assignment_target_property_property(
        &mut self,
        property: &oxc_ast::ast::AssignmentTargetPropertyProperty<'a>,
    ) {
        self.visit_assignment_target_maybe_default(&property.binding);
    }
}

fn import_declaration_kind(declaration: &ImportDeclaration<'_>) -> DependencyReferenceKind {
    if declaration.import_kind == ImportOrExportKind::Type
        || declaration.specifiers.as_ref().is_some_and(|specifiers| {
            !specifiers.is_empty()
                && specifiers.iter().all(|specifier| {
                    matches!(
                        specifier,
                        ImportDeclarationSpecifier::ImportSpecifier(specifier)
                            if specifier.import_kind == ImportOrExportKind::Type
                    )
                })
        })
    {
        DependencyReferenceKind::NodeType
    } else {
        DependencyReferenceKind::NodeRuntime
    }
}

fn export_named_kind(declaration: &ExportNamedDeclaration<'_>) -> DependencyReferenceKind {
    if declaration.export_kind == ImportOrExportKind::Type
        || (!declaration.specifiers.is_empty()
            && declaration
                .specifiers
                .iter()
                .all(|specifier| specifier.export_kind == ImportOrExportKind::Type))
    {
        DependencyReferenceKind::NodeType
    } else {
        DependencyReferenceKind::NodeRuntime
    }
}

const fn reference_kind(kind: ImportOrExportKind) -> DependencyReferenceKind {
    match kind {
        ImportOrExportKind::Value => DependencyReferenceKind::NodeRuntime,
        ImportOrExportKind::Type => DependencyReferenceKind::NodeType,
    }
}

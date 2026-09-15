use oxc_ast::ast::{
    ExportNamedDeclaration, ImportDeclaration, ImportDeclarationSpecifier, ImportOrExportKind,
    Statement,
};
use oxc_parser::{Kind, ParserReturn};

use crate::{
    limits::MAX_DEPENDENCY_FACTS_PER_FILE,
    model::{
        DependencyExtractionStatus, DependencyFacts, DependencyReference, DependencyReferenceKind,
    },
};

use super::LexToken;

pub(super) fn extract(parsed: &ParserReturn<'_>, tokens: &[LexToken]) -> DependencyFacts {
    if parsed.panicked || !parsed.diagnostics.is_empty() {
        return crate::analysis::parser_failed_dependencies();
    }
    let mut collector = Collector::default();
    for statement in &parsed.program.body {
        collector.observe_statement(statement);
    }
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
            _ => {}
        }
    }

    fn observe_unsupported_loaders(&mut self, tokens: &[LexToken]) {
        for pair in tokens.windows(2) {
            if (pair[0].kind == Kind::Import || pair[0].text == "require")
                && pair[1].kind == Kind::LParen
            {
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

use std::collections::BTreeSet;

use ra_ap_syntax::{
    AstNode, SyntaxNode,
    ast::{self, HasAttrs, HasName, PathSegmentKind},
};

use crate::{
    analysis::AnalysisError,
    cancel::CancelToken,
    limits::MAX_DEPENDENCY_FACTS_PER_FILE,
    model::{
        DependencyExtractionStatus, DependencyFacts, DependencyReference, DependencyReferenceKind,
    },
};

const CONDITIONAL: &str = "conditional_attribute";
const PATH_OVERRIDE: &str = "path_attribute";
const UNSUPPORTED_PATH: &str = "unsupported_path";

pub(super) fn extract(
    root: &SyntaxNode,
    cancel: &CancelToken,
) -> Result<DependencyFacts, AnalysisError> {
    let mut collector = Collector::new(cancel);
    for node in root.descendants() {
        if let Some(module) = ast::Module::cast(node.clone()) {
            collector.observe_module(&module)?;
        } else if let Some(usage) = ast::Use::cast(node) {
            collector.observe_use(&usage)?;
        }
    }
    Ok(collector.finish())
}

struct Collector<'a> {
    cancel: &'a CancelToken,
    references: BTreeSet<DependencyReference>,
    truncated: bool,
    visited: usize,
}

impl<'a> Collector<'a> {
    fn new(cancel: &'a CancelToken) -> Self {
        Self {
            cancel,
            references: BTreeSet::new(),
            truncated: false,
            visited: 0,
        }
    }

    fn observe_module(&mut self, module: &ast::Module) -> Result<(), AnalysisError> {
        self.check_cancel()?;
        if module.item_list().is_some() {
            return Ok(());
        }
        let Some(name) = module.name() else {
            self.push_unsupported(UNSUPPORTED_PATH);
            return Ok(());
        };
        if has_attribute(module, "path") {
            self.push_unsupported(PATH_OVERRIDE);
            return Ok(());
        }
        if is_conditional(module.syntax()) {
            self.push_unsupported(CONDITIONAL);
            return Ok(());
        }
        let mut segments = inline_scope(module.syntax());
        segments.push(normalize_identifier(name.text().as_str()));
        self.push(DependencyReferenceKind::RustModule, segments.join("::"), 0);
        Ok(())
    }

    fn observe_use(&mut self, usage: &ast::Use) -> Result<(), AnalysisError> {
        self.check_cancel()?;
        if is_conditional(usage.syntax()) {
            self.push_unsupported(CONDITIONAL);
            return Ok(());
        }
        let Some(tree) = usage.use_tree() else {
            self.push_unsupported(UNSUPPORTED_PATH);
            return Ok(());
        };
        let mut paths = Vec::new();
        if !flatten_use_tree(&tree, &[], &mut paths) {
            self.push_unsupported(UNSUPPORTED_PATH);
            return Ok(());
        }
        let scope = inline_scope(usage.syntax());
        for segments in paths {
            let Some(specifier) = normalize_use_path(segments, &scope) else {
                continue;
            };
            self.push(DependencyReferenceKind::RustUse, specifier, 0);
        }
        Ok(())
    }

    fn push_unsupported(&mut self, reason: &str) {
        self.push(DependencyReferenceKind::RustUnsupported, reason.into(), 0);
    }

    fn push(&mut self, kind: DependencyReferenceKind, specifier: String, level: u32) {
        if self.references.len() >= MAX_DEPENDENCY_FACTS_PER_FILE {
            self.truncated = true;
            return;
        }
        self.references.insert(DependencyReference {
            kind,
            specifier,
            level,
        });
    }

    fn check_cancel(&mut self) -> Result<(), AnalysisError> {
        self.visited = self.visited.saturating_add(1);
        if self
            .visited
            .is_multiple_of(crate::cancel::CANCELLATION_POLL_INTERVAL)
            && self.cancel.is_cancelled()
        {
            return Err(AnalysisError::Cancelled);
        }
        Ok(())
    }

    fn finish(self) -> DependencyFacts {
        DependencyFacts {
            status: if self.truncated {
                DependencyExtractionStatus::Truncated
            } else {
                DependencyExtractionStatus::Complete
            },
            references: self.references.into_iter().collect(),
        }
    }
}

fn flatten_use_tree(tree: &ast::UseTree, prefix: &[String], output: &mut Vec<Vec<String>>) -> bool {
    let mut path = prefix.to_vec();
    if let Some(tree_path) = tree.path() {
        let Some(mut segments) = path_segments(&tree_path) else {
            return false;
        };
        if prefix.is_empty()
            && tree
                .syntax()
                .text()
                .to_string()
                .trim_start()
                .starts_with("::")
        {
            segments.insert(0, "::".into());
        }
        path.extend(segments);
    }
    if let Some(list) = tree.use_tree_list() {
        return list
            .use_trees()
            .all(|child| flatten_use_tree(&child, &path, output));
    }
    if path.last().is_some_and(|segment| segment == "self") && path.len() > 1 {
        path.pop();
    }
    if !path.is_empty() {
        output.push(path);
    }
    true
}

fn path_segments(path: &ast::Path) -> Option<Vec<String>> {
    path.segments()
        .map(|segment| match segment.kind()? {
            PathSegmentKind::Name(name) => Some(normalize_identifier(name.text().as_str())),
            PathSegmentKind::SelfKw => Some("self".into()),
            PathSegmentKind::SuperKw => Some("super".into()),
            PathSegmentKind::CrateKw => Some("crate".into()),
            PathSegmentKind::SelfTypeKw | PathSegmentKind::Type { .. } => None,
        })
        .collect()
}

fn normalize_use_path(mut path: Vec<String>, inline: &[String]) -> Option<String> {
    let first = path.first()?.as_str();
    if first == "crate" {
        return Some(path.join("::"));
    }
    if first == "::" || matches!(first, "std" | "core" | "alloc" | "proc_macro") {
        return None;
    }
    if first == "self" {
        path.remove(0);
        let mut normalized = Vec::with_capacity(1 + inline.len() + path.len());
        normalized.push("self".into());
        normalized.extend(inline.iter().cloned());
        normalized.extend(path);
        return Some(normalized.join("::"));
    }
    if first == "super" {
        let mut supers = 0usize;
        while path.first().is_some_and(|segment| segment == "super") {
            path.remove(0);
            supers = supers.saturating_add(1);
        }
        let retained = inline.len().saturating_sub(supers);
        let external_supers = supers.saturating_sub(inline.len());
        let mut normalized = Vec::with_capacity(external_supers + retained + path.len() + 1);
        if external_supers == 0 {
            normalized.push("self".into());
            normalized.extend(inline[..retained].iter().cloned());
        } else {
            normalized.extend(std::iter::repeat_n("super".into(), external_supers));
        }
        normalized.extend(path);
        return Some(normalized.join("::"));
    }
    let mut normalized = inline.to_vec();
    normalized.extend(path);
    Some(normalized.join("::"))
}

fn inline_scope(node: &SyntaxNode) -> Vec<String> {
    let mut modules = node
        .ancestors()
        .skip(1)
        .filter_map(ast::Module::cast)
        .filter(|module| module.item_list().is_some())
        .filter_map(|module| module.name())
        .map(|name| normalize_identifier(name.text().as_str()))
        .collect::<Vec<_>>();
    modules.reverse();
    modules
}

fn is_conditional(node: &SyntaxNode) -> bool {
    node.ancestors().any(|ancestor| {
        ast::Module::cast(ancestor.clone()).is_some_and(|module| {
            has_attribute_including_inner(&module, "cfg")
                || has_attribute_including_inner(&module, "cfg_attr")
        }) || ast::Use::cast(ancestor.clone())
            .is_some_and(|usage| has_attribute(&usage, "cfg") || has_attribute(&usage, "cfg_attr"))
            || ast::SourceFile::cast(ancestor).is_some_and(|source| {
                has_attribute_including_inner(&source, "cfg")
                    || has_attribute_including_inner(&source, "cfg_attr")
            })
    })
}

fn has_attribute(owner: &impl HasAttrs, name: &str) -> bool {
    attributes_named(owner.attrs(), name)
}

fn has_attribute_including_inner(owner: &impl HasAttrs, name: &str) -> bool {
    attributes_named(ast::attrs_including_inner(owner), name)
}

fn attributes_named(attributes: impl Iterator<Item = ast::Attr>, name: &str) -> bool {
    attributes.into_iter().any(|attribute| {
        let text = attribute.syntax().text().to_string();
        let trimmed = text
            .trim_start_matches('#')
            .trim_start_matches('!')
            .trim_start();
        let Some(body) = trimmed.strip_prefix('[').map(str::trim_start) else {
            return false;
        };
        body.strip_prefix(name).is_some_and(|rest| {
            rest.starts_with(|character: char| {
                character.is_ascii_whitespace() || matches!(character, '(' | '=' | ']')
            })
        })
    })
}

fn normalize_identifier(identifier: &str) -> String {
    identifier.strip_prefix("r#").unwrap_or(identifier).into()
}

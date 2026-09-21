use std::collections::{BTreeMap, BTreeSet};

use crate::{
    documentation::DocumentationRegistry,
    model::Language,
    path::RepoPath,
    source::git::{AuxiliaryPathState, detect_language},
};

use super::model::{
    DocumentationReason, DocumentationRequirement, ImportantNodeObservation, SenseIssue,
};

#[derive(Clone, Copy)]
pub(super) struct DocumentationPolicy {
    pub important_fan_in: usize,
    pub important_exports: usize,
}

#[derive(Clone, Copy)]
pub(super) struct DocumentationInputs<'a> {
    pub nodes: &'a [ImportantNodeObservation],
    pub after_registry: Option<&'a DocumentationRegistry>,
    pub documents: &'a BTreeMap<RepoPath, AuxiliaryPathState>,
    pub policy: DocumentationPolicy,
    pub finding_limit: usize,
}

pub(super) struct DocumentationResult {
    pub requirements: Vec<DocumentationRequirement>,
    pub coverage_issues: Vec<SenseIssue>,
    pub findings_truncated: bool,
    pub documents_requested: usize,
    pub before_documents: usize,
    pub after_documents: usize,
    pub changed_documents: usize,
    pub public_surface_candidates: usize,
    pub authoritative_public_surfaces: usize,
    pub unavailable_public_surfaces: usize,
}

pub(super) fn needs_evaluation(
    nodes: &[ImportantNodeObservation],
    policy: DocumentationPolicy,
) -> bool {
    nodes.iter().any(|node| {
        trigger(node, policy).is_some() || python_public_surface_candidate(node, policy)
    })
}

pub(super) fn referenced_documents(
    nodes: &[ImportantNodeObservation],
    after_registry: Option<&DocumentationRegistry>,
    policy: DocumentationPolicy,
) -> BTreeSet<RepoPath> {
    let mut paths = BTreeSet::new();
    for node in nodes {
        let Some(trigger) = trigger(node, policy) else {
            continue;
        };
        if !trigger.deleted
            && let Some(document) =
                after_registry.and_then(|registry| registry.document_for(&node.path))
        {
            paths.insert(document.clone());
        }
    }
    paths
}

pub(super) fn evaluate(inputs: DocumentationInputs<'_>) -> DocumentationResult {
    let mut requirements = Vec::new();
    let mut coverage_issues = Vec::new();
    let mut public_surface_candidates = 0usize;
    let mut authoritative_public_surfaces = 0usize;
    let mut unavailable_public_surfaces = 0usize;
    for node in inputs.nodes {
        if let Some(trigger) = trigger(node, inputs.policy) {
            evaluate_node(&inputs, node, trigger, &mut requirements);
        }
        let Some(document) = python_public_surface_document(&inputs, node) else {
            continue;
        };
        public_surface_candidates = public_surface_candidates.saturating_add(1);
        if node.before_public_surface_authoritative && node.after_public_surface_authoritative {
            authoritative_public_surfaces = authoritative_public_surfaces.saturating_add(1);
            continue;
        }
        unavailable_public_surfaces = unavailable_public_surfaces.saturating_add(1);
        let mut issue = SenseIssue::new(
            "sense.documentation.public_surface_unavailable",
            format!(
                concat!(
                    "could not evaluate sense.documentation.document_not_updated for {} and its ",
                    "registered document {} because the Python public surface was not ",
                    "authoritative in both views"
                ),
                node.path, document
            ),
        );
        issue.paths.push(node.path.clone());
        coverage_issues.push(issue);
    }
    requirements.sort();
    coverage_issues.sort_by(|left, right| left.paths.cmp(&right.paths));
    let result_count = requirements.len().saturating_add(coverage_issues.len());
    let findings_truncated = result_count > inputs.finding_limit;
    if requirements.len() >= inputs.finding_limit {
        requirements.truncate(inputs.finding_limit);
        coverage_issues.clear();
    } else {
        coverage_issues.truncate(inputs.finding_limit - requirements.len());
    }
    let (before_documents, after_documents, changed_documents) = document_counts(inputs.documents);
    DocumentationResult {
        requirements,
        coverage_issues,
        findings_truncated,
        documents_requested: inputs.documents.len(),
        before_documents,
        after_documents,
        changed_documents,
        public_surface_candidates,
        authoritative_public_surfaces,
        unavailable_public_surfaces,
    }
}

fn python_public_surface_document<'a>(
    inputs: &'a DocumentationInputs<'_>,
    node: &ImportantNodeObservation,
) -> Option<&'a RepoPath> {
    python_public_surface_candidate(node, inputs.policy)
        .then(|| inputs.after_registry?.document_for(&node.path))?
}

fn python_public_surface_candidate(
    node: &ImportantNodeObservation,
    policy: DocumentationPolicy,
) -> bool {
    !node.deleted
        && detect_language(&node.path).is_some_and(|(language, _)| language == Language::Python)
        && (important(
            node.before_confirmed_dependency_fan_in,
            node.before_public_surface_authoritative,
            node.before_explicit_exports,
            policy,
        ) || important(
            node.after_confirmed_dependency_fan_in,
            node.after_public_surface_authoritative,
            node.after_explicit_exports,
            policy,
        ))
}

#[derive(Clone, Copy)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "four independent documentation reasons are retained allocation-free on the hot path"
)]
struct Trigger {
    newly_important: bool,
    surface_changed: bool,
    renamed: bool,
    deleted: bool,
}

impl Trigger {
    fn reasons(self) -> Vec<DocumentationReason> {
        let mut reasons = Vec::new();
        if self.newly_important {
            reasons.push(DocumentationReason::NewlyImportant);
        }
        if self.surface_changed {
            reasons.push(DocumentationReason::PublicSurfaceChanged);
        }
        if self.renamed {
            reasons.push(DocumentationReason::Renamed);
        }
        if self.deleted {
            reasons.push(DocumentationReason::Deleted);
        }
        reasons
    }

    fn actionable(self) -> bool {
        self.newly_important || self.surface_changed || self.renamed || self.deleted
    }
}

fn trigger(node: &ImportantNodeObservation, policy: DocumentationPolicy) -> Option<Trigger> {
    let before_important = important(
        node.before_confirmed_dependency_fan_in,
        node.before_public_surface_authoritative,
        node.before_explicit_exports,
        policy,
    );
    let after_important = important(
        node.after_confirmed_dependency_fan_in,
        node.after_public_surface_authoritative,
        node.after_explicit_exports,
        policy,
    );
    let path_changed = node
        .before_path
        .as_ref()
        .is_some_and(|before| before != &node.path);
    let trigger = Trigger {
        newly_important: newly_important(node, after_important),
        surface_changed: surface_changed(node, before_important),
        renamed: path_changed && (before_important || after_important),
        deleted: node.deleted && before_important,
    };
    trigger.actionable().then_some(trigger)
}

fn important(
    dependency_fan_in: usize,
    surface_authoritative: bool,
    explicit_exports: usize,
    policy: DocumentationPolicy,
) -> bool {
    dependency_fan_in >= policy.important_fan_in
        || (surface_authoritative && explicit_exports > policy.important_exports)
}

fn newly_important(node: &ImportantNodeObservation, after_important: bool) -> bool {
    node.newly_important && after_important && !node.deleted
}

fn surface_changed(node: &ImportantNodeObservation, before_important: bool) -> bool {
    before_important && !node.deleted && node.public_surface_changed
}

fn evaluate_node(
    inputs: &DocumentationInputs<'_>,
    node: &ImportantNodeObservation,
    trigger: Trigger,
    requirements: &mut Vec<DocumentationRequirement>,
) {
    let before_source = node.before_path.as_ref().unwrap_or(&node.path);
    let reasons = trigger.reasons();

    if (trigger.renamed || trigger.deleted)
        && let Some(document) = inputs
            .after_registry
            .and_then(|registry| registry.document_for(before_source))
    {
        requirements.push(requirement(
            "sense.documentation.stale_binding",
            &node.path,
            node.before_path.clone(),
            Some(document.clone()),
            &reasons,
        ));
    }
    if trigger.deleted {
        return;
    }

    let Some(after_document) = inputs
        .after_registry
        .and_then(|registry| registry.document_for(&node.path))
    else {
        requirements.push(requirement(
            "sense.documentation.missing_binding",
            &node.path,
            node.before_path.clone(),
            None,
            &reasons,
        ));
        return;
    };
    let Some(document_state) = inputs.documents.get(after_document) else {
        requirements.push(requirement(
            "sense.documentation.missing_document",
            &node.path,
            node.before_path.clone(),
            Some(after_document.clone()),
            &reasons,
        ));
        return;
    };
    if document_state.after.is_none() {
        requirements.push(requirement(
            "sense.documentation.missing_document",
            &node.path,
            node.before_path.clone(),
            Some(after_document.clone()),
            &reasons,
        ));
        return;
    }

    if trigger.surface_changed && !document_state.content_changed() {
        requirements.push(requirement(
            "sense.documentation.document_not_updated",
            &node.path,
            node.before_path.clone(),
            Some(after_document.clone()),
            &reasons,
        ));
    }
}

fn requirement(
    code: &str,
    path: &RepoPath,
    before_path: Option<RepoPath>,
    document: Option<RepoPath>,
    reasons: &[DocumentationReason],
) -> DocumentationRequirement {
    DocumentationRequirement {
        code: code.into(),
        path: path.clone(),
        before_path,
        document,
        reasons: reasons.to_vec(),
    }
}

fn document_counts(documents: &BTreeMap<RepoPath, AuxiliaryPathState>) -> (usize, usize, usize) {
    let mut before = 0usize;
    let mut after = 0usize;
    let mut changed = 0usize;
    for state in documents.values() {
        before = before.saturating_add(usize::from(state.before.is_some()));
        after = after.saturating_add(usize::from(state.after.is_some()));
        changed = changed.saturating_add(usize::from(state.content_changed()));
    }
    (before, after, changed)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::{
        documentation::parse_documentation_registry, identity::ContentId,
        source::git::AuxiliaryBlob,
    };

    use super::*;

    fn path(value: &str) -> RepoPath {
        RepoPath::from_protocol(value).unwrap()
    }

    fn registry(bindings: &[(&str, &str)]) -> DocumentationRegistry {
        let bindings = bindings
            .iter()
            .map(|(source, document)| {
                format!(
                    r#"{{"source":{},"document":{}}}"#,
                    serde_json::to_string(source).unwrap(),
                    serde_json::to_string(document).unwrap()
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        parse_documentation_registry(
            format!(r#"{{"schemaVersion":1,"documentation":{{"bindings":[{bindings}]}}}}"#)
                .as_bytes(),
        )
        .unwrap()
    }

    fn blob(bytes: &[u8]) -> AuxiliaryBlob {
        AuxiliaryBlob {
            content_id: ContentId::of(bytes),
            bytes: Arc::from(bytes),
        }
    }

    type DocumentFixture<'a> = (&'a str, Option<&'a [u8]>, Option<&'a [u8]>);

    fn documents(entries: &[DocumentFixture<'_>]) -> BTreeMap<RepoPath, AuxiliaryPathState> {
        entries
            .iter()
            .map(|(path_value, before, after)| {
                (
                    path(path_value),
                    AuxiliaryPathState {
                        before: before.map(blob),
                        after: after.map(blob),
                    },
                )
            })
            .collect()
    }

    fn important(path_value: &str) -> ImportantNodeObservation {
        ImportantNodeObservation {
            path: path(path_value),
            before_path: None,
            deleted: false,
            before_confirmed_dependency_fan_in: 9,
            after_confirmed_dependency_fan_in: 10,
            before_explicit_exports: 1,
            after_explicit_exports: 1,
            before_public_surface_authoritative: true,
            after_public_surface_authoritative: true,
            newly_important: true,
            public_surface_changed: false,
        }
    }

    fn policy() -> DocumentationPolicy {
        DocumentationPolicy {
            important_fan_in: 10,
            important_exports: 20,
        }
    }

    fn evaluate_one(
        node: ImportantNodeObservation,
        _before: Option<&DocumentationRegistry>,
        after: Option<&DocumentationRegistry>,
        docs: &BTreeMap<RepoPath, AuxiliaryPathState>,
    ) -> DocumentationResult {
        evaluate(DocumentationInputs {
            nodes: &[node],
            after_registry: after,
            documents: docs,
            policy: policy(),
            finding_limit: 32,
        })
    }

    #[test]
    fn newly_important_requires_an_exact_binding_and_existing_document() {
        let node = important("src/core.ts");
        let missing = evaluate_one(node.clone(), None, None, &BTreeMap::new());
        assert_eq!(
            missing.requirements[0].code,
            "sense.documentation.missing_binding"
        );

        let registry = registry(&[("src/core.ts", "docs/core.md")]);
        let absent = evaluate_one(
            node.clone(),
            None,
            Some(&registry),
            &documents(&[("docs/core.md", None, None)]),
        );
        assert_eq!(
            absent.requirements[0].code,
            "sense.documentation.missing_document"
        );

        let present = documents(&[("docs/core.md", Some(b"old"), Some(b"old"))]);
        assert!(
            evaluate_one(node, Some(&registry), Some(&registry), &present)
                .requirements
                .is_empty()
        );
    }

    #[test]
    fn existing_important_surface_requires_changed_document_bytes() {
        let mut node = important("src/core.ts");
        node.before_confirmed_dependency_fan_in = 10;
        node.newly_important = false;
        node.public_surface_changed = true;
        let before = registry(&[("src/core.ts", "docs/core.md")]);
        let unchanged = documents(&[("docs/core.md", Some(b"same"), Some(b"same"))]);
        let finding = evaluate_one(node.clone(), Some(&before), Some(&before), &unchanged);
        assert_eq!(
            finding.requirements[0].code,
            "sense.documentation.document_not_updated"
        );

        let changed = documents(&[("docs/core.md", Some(b"old"), Some(b"new"))]);
        assert!(
            evaluate_one(node.clone(), Some(&before), Some(&before), &changed)
                .requirements
                .is_empty()
        );

        let after = registry(&[("src/core.ts", "docs/new-core.md")]);
        let rebound = documents(&[("docs/new-core.md", Some(b"existing"), Some(b"existing"))]);
        assert_eq!(
            evaluate_one(node.clone(), Some(&before), Some(&after), &rebound).requirements[0].code,
            "sense.documentation.document_not_updated"
        );

        let rebound_and_changed =
            documents(&[("docs/new-core.md", Some(b"existing"), Some(b"updated"))]);
        assert!(
            evaluate_one(node, Some(&before), Some(&after), &rebound_and_changed)
                .requirements
                .is_empty()
        );
    }

    #[test]
    fn surface_change_still_requires_docs_when_module_drops_below_importance_limit() {
        let mut node = important("src/core.ts");
        node.before_confirmed_dependency_fan_in = 0;
        node.after_confirmed_dependency_fan_in = 0;
        node.before_explicit_exports = 21;
        node.after_explicit_exports = 20;
        node.newly_important = false;
        node.public_surface_changed = true;
        let registry = registry(&[("src/core.ts", "docs/core.md")]);
        let unchanged = documents(&[("docs/core.md", Some(b"same"), Some(b"same"))]);

        let result = evaluate_one(node, Some(&registry), Some(&registry), &unchanged);

        assert_eq!(
            result.requirements[0].code,
            "sense.documentation.document_not_updated"
        );
    }

    #[test]
    fn important_rename_requires_moved_binding_but_not_changed_document_bytes() {
        let mut node = important("src/new.ts");
        node.before_path = Some(path("src/old.ts"));
        node.before_confirmed_dependency_fan_in = 10;
        node.newly_important = false;
        let before = registry(&[("src/old.ts", "docs/core.md")]);
        let stale = registry(&[("src/old.ts", "docs/core.md")]);
        let docs = documents(&[("docs/core.md", Some(b"same"), Some(b"same"))]);
        let findings = evaluate_one(node.clone(), Some(&before), Some(&stale), &docs);
        assert_eq!(findings.requirements.len(), 2);
        assert!(
            findings
                .requirements
                .iter()
                .any(|finding| finding.code == "sense.documentation.stale_binding")
        );
        assert!(
            findings
                .requirements
                .iter()
                .any(|finding| finding.code == "sense.documentation.missing_binding")
        );

        let moved = registry(&[("src/new.ts", "docs/core.md")]);
        assert!(
            evaluate_one(node, Some(&before), Some(&moved), &docs)
                .requirements
                .is_empty()
        );
    }

    #[test]
    fn important_deletion_rejects_only_a_retained_stale_binding() {
        let mut node = important("src/core.ts");
        node.before_confirmed_dependency_fan_in = 10;
        node.after_confirmed_dependency_fan_in = 0;
        node.newly_important = false;
        node.deleted = true;
        let registry = registry(&[("src/core.ts", "docs/core.md")]);
        let stale = evaluate_one(
            node.clone(),
            Some(&registry),
            Some(&registry),
            &BTreeMap::new(),
        );
        assert_eq!(
            stale.requirements[0].code,
            "sense.documentation.stale_binding"
        );
        assert!(
            evaluate_one(node, Some(&registry), None, &BTreeMap::new())
                .requirements
                .is_empty()
        );
    }

    #[test]
    fn important_internal_change_without_a_policy_transition_reads_nothing() {
        let mut node = important("src/core.ts");
        node.before_confirmed_dependency_fan_in = 10;
        node.newly_important = false;
        assert!(!needs_evaluation(&[node], policy()));
    }
}

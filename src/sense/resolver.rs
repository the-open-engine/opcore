use std::collections::{BTreeMap, BTreeSet, btree_map::Entry};

mod classification;
mod evidence;
mod go;
mod node;
mod pair;
mod rust;

#[cfg(test)]
use pair::can_incrementally_project;
pub(crate) use pair::{PairInput, project_pair};

use crate::{
    facts,
    limits::{MAX_GRAPH_EDGES, MAX_INTERFACE_SELECTORS},
    model::{
        DependencyExtractionStatus, DependencyReference, DependencyReferenceKind, FileFacts,
        InterfaceExtractionStatus, InterfaceFacts, InterfaceImportRole, InterfaceNamespace,
        InterfaceSelectorKind, InterfaceSurfaceStatus, Language, SourceFile,
    },
    path::RepoPath,
    source::{snapshot::SourceSnapshot, strip_language_suffix},
};

use super::model::{
    DependencyEdge, EdgeKind, InterfaceEdgeKey, InterfaceExportKey, InterfaceShapeKey,
    ModuleInterface, Projection, ResolutionCoverage, ResolutionGapKind,
};
use classification::{ReferenceClass, reference_class};
use evidence::{record_reference_gap, record_resolution_gap};

struct ResolutionIndex {
    languages: BTreeMap<RepoPath, Language>,
    node_aliases: BTreeMap<String, Candidate>,
    python_aliases: BTreeMap<String, Candidate>,
    rust: rust::Index,
    go: go::Index,
}

#[derive(Clone)]
enum Candidate {
    Unique(RepoPath),
    Ambiguous,
}

impl ResolutionIndex {
    fn new(
        snapshot: &SourceSnapshot,
        file_facts: &facts::FactMap,
        parser_options: &[u8],
        go_modules: &BTreeMap<RepoPath, std::sync::Arc<[u8]>>,
    ) -> Self {
        let languages = snapshot
            .files()
            .map(|file| (file.path.clone(), file.language))
            .collect::<BTreeMap<_, _>>();
        let mut index = Self {
            languages,
            node_aliases: BTreeMap::new(),
            python_aliases: BTreeMap::new(),
            rust: rust::Index::default(),
            go: go::Index::build(snapshot, go_modules),
        };
        for file in snapshot.files() {
            index.add_file(file);
        }
        index
            .rust
            .confirm_module_trees(snapshot, file_facts, parser_options);
        index
    }

    fn add_file(&mut self, file: &SourceFile) {
        let Some(path) = file.path.as_utf8() else {
            return;
        };
        match file.language {
            Language::JavaScript | Language::TypeScript => {
                add_source_aliases(&mut self.node_aliases, path, file, "/index");
            }
            Language::Python => {
                add_source_aliases(&mut self.python_aliases, path, file, "/__init__");
            }
            Language::Rust => {
                self.rust.add_file(file, path);
            }
            Language::Go | Language::Hcl | Language::Shell | Language::Protobuf => {}
        }
    }
}

fn add_source_aliases(
    aliases: &mut BTreeMap<String, Candidate>,
    path: &str,
    file: &SourceFile,
    package_suffix: &str,
) {
    let Some(stem) = strip_language_suffix(path, file.language) else {
        return;
    };
    add_candidate(aliases, stem, &file.path);
    if let Some(directory) = stem.strip_suffix(package_suffix) {
        add_candidate(aliases, directory, &file.path);
    }
}

fn add_candidate(aliases: &mut BTreeMap<String, Candidate>, alias: &str, target: &RepoPath) {
    use std::collections::btree_map::Entry;

    match aliases.entry(alias.to_owned()) {
        Entry::Vacant(entry) => {
            entry.insert(Candidate::Unique(target.clone()));
        }
        Entry::Occupied(mut entry) => {
            if matches!(entry.get(), Candidate::Unique(existing) if existing != target) {
                entry.insert(Candidate::Ambiguous);
            }
        }
    }
}

#[cfg(test)]
fn project(
    snapshot: &SourceSnapshot,
    file_facts: &facts::FactMap,
    parser_options: &[u8],
) -> Projection {
    let index = ResolutionIndex::new(snapshot, file_facts, parser_options, &BTreeMap::new());
    let interface_paths = snapshot.paths().cloned().collect();
    let context = ResolutionContext {
        file_facts,
        parser_options,
        index: &index,
        interface_paths: &interface_paths,
    };
    project_with_index(snapshot, &context)
}

struct ResolutionContext<'a> {
    file_facts: &'a facts::FactMap,
    parser_options: &'a [u8],
    index: &'a ResolutionIndex,
    interface_paths: &'a BTreeSet<RepoPath>,
}

fn project_with_index(snapshot: &SourceSnapshot, context: &ResolutionContext<'_>) -> Projection {
    let mut projection = Projection {
        nodes: context.index.languages.keys().cloned().collect(),
        coverage: ResolutionCoverage {
            files: snapshot.len(),
            configuration_errors: context.index.go.configuration_errors(),
            ..ResolutionCoverage::default()
        },
        ..Projection::default()
    };
    for file in snapshot.files() {
        observe_file(&mut projection, file, context);
    }
    projection
}

fn update_changed_importers(
    before: &SourceSnapshot,
    after: &SourceSnapshot,
    mut projection: Projection,
    context: &ResolutionContext<'_>,
    changed_paths: &BTreeSet<RepoPath>,
) -> Projection {
    for path in changed_paths {
        let Some(after_file) = after.read(path) else {
            continue;
        };
        let Some(before_file) = before.read(path) else {
            continue;
        };
        if facts::key(&before_file, context.parser_options)
            == facts::key(&after_file, context.parser_options)
        {
            continue;
        }
        let before_contribution = project_file(&before_file, context);
        subtract_contribution(&mut projection, &before_contribution);
        let after_contribution = project_file(&after_file, context);
        add_contribution(&mut projection, after_contribution);
    }
    projection
}

fn project_file(file: &SourceFile, context: &ResolutionContext<'_>) -> Projection {
    let mut projection = Projection {
        nodes: BTreeSet::from([file.path.clone()]),
        coverage: ResolutionCoverage {
            files: 1,
            ..ResolutionCoverage::default()
        },
        ..Projection::default()
    };
    observe_file(&mut projection, file, context);
    projection
}

fn observe_file(projection: &mut Projection, file: &SourceFile, context: &ResolutionContext<'_>) {
    let key = facts::key(file, context.parser_options);
    let Some(file_facts) = context.file_facts.get(&key) else {
        projection.coverage.parser_failed_files =
            projection.coverage.parser_failed_files.saturating_add(1);
        return;
    };
    let logical_path = context.index.go.logical_path(file);
    let project_interfaces = context.interface_paths.contains(&logical_path);
    observe_extraction_status(&mut projection.coverage, file_facts);
    observe_interface_facts(
        projection,
        file,
        file_facts,
        &logical_path,
        project_interfaces,
    );
    for reference in &file_facts.dependencies.references {
        resolve_reference(
            projection,
            context.index,
            file,
            reference,
            project_interfaces.then_some(&file_facts.interfaces),
        );
    }
}

fn add_contribution(projection: &mut Projection, contribution: Projection) {
    let selector_count = projection.interface_coverage.resolved_selectors;
    add_coverage(&mut projection.coverage, &contribution.coverage);
    add_interface_coverage(
        &mut projection.interface_coverage,
        &contribution.interface_coverage,
    );
    projection.resolution_gaps_truncated |= contribution.resolution_gaps_truncated;
    for gap in contribution.resolution_gaps {
        record_resolution_gap(projection, gap);
    }
    projection.interface_coverage.resolved_selectors = selector_count;
    for edge in contribution.edges {
        if !projection.edges.contains(&edge) && projection.edges.len() >= MAX_GRAPH_EDGES {
            projection.coverage.edges_truncated = true;
        } else {
            projection.edges.insert(edge);
        }
    }
    projection.interfaces.extend(contribution.interfaces);
    for (key, edge) in contribution.interface_edges {
        let destination = projection.interface_edges.entry(key).or_default();
        destination.unknown_width |= edge.unknown_width;
        for selector in edge.selectors {
            if destination.selectors.contains(&selector) {
                continue;
            }
            if projection.interface_coverage.resolved_selectors >= MAX_INTERFACE_SELECTORS {
                projection.interface_coverage.selectors_truncated = true;
                continue;
            }
            destination.selectors.insert(selector);
            projection.interface_coverage.resolved_selectors = projection
                .interface_coverage
                .resolved_selectors
                .saturating_add(1);
        }
    }
}

fn subtract_contribution(projection: &mut Projection, contribution: &Projection) {
    subtract_coverage(&mut projection.coverage, &contribution.coverage);
    for gap in &contribution.resolution_gaps {
        projection.resolution_gaps.remove(gap);
    }
    for edge in &contribution.edges {
        projection.edges.remove(edge);
    }
    subtract_interface_coverage(
        &mut projection.interface_coverage,
        &contribution.interface_coverage,
    );
    for path in contribution.interfaces.keys() {
        projection.interfaces.remove(path);
    }
    for key in contribution.interface_edges.keys() {
        projection.interface_edges.remove(key);
    }
}

fn add_interface_coverage(
    total: &mut super::model::InterfaceCoverage,
    item: &super::model::InterfaceCoverage,
) {
    total.files = total.files.saturating_add(item.files);
    total.complete_files = total.complete_files.saturating_add(item.complete_files);
    total.partial_files = total.partial_files.saturating_add(item.partial_files);
    total.unsupported_files = total
        .unsupported_files
        .saturating_add(item.unsupported_files);
    total.parser_failed_files = total
        .parser_failed_files
        .saturating_add(item.parser_failed_files);
    total.truncated_files = total.truncated_files.saturating_add(item.truncated_files);
    total.complete_public_surfaces = total
        .complete_public_surfaces
        .saturating_add(item.complete_public_surfaces);
    total.partial_public_surfaces = total
        .partial_public_surfaces
        .saturating_add(item.partial_public_surfaces);
    total.unsupported_public_surfaces = total
        .unsupported_public_surfaces
        .saturating_add(item.unsupported_public_surfaces);
    total.truncated_public_surfaces = total
        .truncated_public_surfaces
        .saturating_add(item.truncated_public_surfaces);
    total.resolved_selectors = total
        .resolved_selectors
        .saturating_add(item.resolved_selectors);
    total.selectors_truncated |= item.selectors_truncated;
    add_interface_gaps(&mut total.gaps, &item.gaps);
}

fn subtract_interface_coverage(
    total: &mut super::model::InterfaceCoverage,
    item: &super::model::InterfaceCoverage,
) {
    total.files = total.files.saturating_sub(item.files);
    total.complete_files = total.complete_files.saturating_sub(item.complete_files);
    total.partial_files = total.partial_files.saturating_sub(item.partial_files);
    total.unsupported_files = total
        .unsupported_files
        .saturating_sub(item.unsupported_files);
    total.parser_failed_files = total
        .parser_failed_files
        .saturating_sub(item.parser_failed_files);
    total.truncated_files = total.truncated_files.saturating_sub(item.truncated_files);
    total.complete_public_surfaces = total
        .complete_public_surfaces
        .saturating_sub(item.complete_public_surfaces);
    total.partial_public_surfaces = total
        .partial_public_surfaces
        .saturating_sub(item.partial_public_surfaces);
    total.unsupported_public_surfaces = total
        .unsupported_public_surfaces
        .saturating_sub(item.unsupported_public_surfaces);
    total.truncated_public_surfaces = total
        .truncated_public_surfaces
        .saturating_sub(item.truncated_public_surfaces);
    total.resolved_selectors = total
        .resolved_selectors
        .saturating_sub(item.resolved_selectors);
    subtract_interface_gaps(&mut total.gaps, &item.gaps);
}

fn add_interface_gaps(
    total: &mut crate::model::InterfaceGapCounts,
    item: &crate::model::InterfaceGapCounts,
) {
    total.wildcard_exports = total.wildcard_exports.saturating_add(item.wildcard_exports);
    total.namespace_imports = total
        .namespace_imports
        .saturating_add(item.namespace_imports);
    total.common_js_exports = total
        .common_js_exports
        .saturating_add(item.common_js_exports);
    total.dynamic_loaders = total.dynamic_loaders.saturating_add(item.dynamic_loaders);
    total.unsupported_patterns = total
        .unsupported_patterns
        .saturating_add(item.unsupported_patterns);
}

fn subtract_interface_gaps(
    total: &mut crate::model::InterfaceGapCounts,
    item: &crate::model::InterfaceGapCounts,
) {
    total.wildcard_exports = total.wildcard_exports.saturating_sub(item.wildcard_exports);
    total.namespace_imports = total
        .namespace_imports
        .saturating_sub(item.namespace_imports);
    total.common_js_exports = total
        .common_js_exports
        .saturating_sub(item.common_js_exports);
    total.dynamic_loaders = total.dynamic_loaders.saturating_sub(item.dynamic_loaders);
    total.unsupported_patterns = total
        .unsupported_patterns
        .saturating_sub(item.unsupported_patterns);
}

fn add_coverage(total: &mut ResolutionCoverage, item: &ResolutionCoverage) {
    total.files = total.files.saturating_add(item.files);
    total.complete_files = total.complete_files.saturating_add(item.complete_files);
    total.unsupported_files = total
        .unsupported_files
        .saturating_add(item.unsupported_files);
    total.parser_failed_files = total
        .parser_failed_files
        .saturating_add(item.parser_failed_files);
    total.truncated_files = total.truncated_files.saturating_add(item.truncated_files);
    total.runtime_references = total
        .runtime_references
        .saturating_add(item.runtime_references);
    total.type_references = total.type_references.saturating_add(item.type_references);
    total.structural_references = total
        .structural_references
        .saturating_add(item.structural_references);
    total.resolved_references = total
        .resolved_references
        .saturating_add(item.resolved_references);
    total.node_builtin_references = total
        .node_builtin_references
        .saturating_add(item.node_builtin_references);
    total.external_references = total
        .external_references
        .saturating_add(item.external_references);
    total.ambiguous_references = total
        .ambiguous_references
        .saturating_add(item.ambiguous_references);
    total.unresolved_references = total
        .unresolved_references
        .saturating_add(item.unresolved_references);
    total.unsupported_dynamic_references = total
        .unsupported_dynamic_references
        .saturating_add(item.unsupported_dynamic_references);
    total.configuration_errors = total
        .configuration_errors
        .saturating_add(item.configuration_errors);
    total.edges_truncated |= item.edges_truncated;
}

fn subtract_coverage(total: &mut ResolutionCoverage, item: &ResolutionCoverage) {
    total.files = total.files.saturating_sub(item.files);
    total.complete_files = total.complete_files.saturating_sub(item.complete_files);
    total.unsupported_files = total
        .unsupported_files
        .saturating_sub(item.unsupported_files);
    total.parser_failed_files = total
        .parser_failed_files
        .saturating_sub(item.parser_failed_files);
    total.truncated_files = total.truncated_files.saturating_sub(item.truncated_files);
    total.runtime_references = total
        .runtime_references
        .saturating_sub(item.runtime_references);
    total.type_references = total.type_references.saturating_sub(item.type_references);
    total.structural_references = total
        .structural_references
        .saturating_sub(item.structural_references);
    total.resolved_references = total
        .resolved_references
        .saturating_sub(item.resolved_references);
    total.node_builtin_references = total
        .node_builtin_references
        .saturating_sub(item.node_builtin_references);
    total.external_references = total
        .external_references
        .saturating_sub(item.external_references);
    total.ambiguous_references = total
        .ambiguous_references
        .saturating_sub(item.ambiguous_references);
    total.unresolved_references = total
        .unresolved_references
        .saturating_sub(item.unresolved_references);
    total.unsupported_dynamic_references = total
        .unsupported_dynamic_references
        .saturating_sub(item.unsupported_dynamic_references);
    total.configuration_errors = total
        .configuration_errors
        .saturating_sub(item.configuration_errors);
}

fn observe_extraction_status(coverage: &mut ResolutionCoverage, facts: &FileFacts) {
    match facts.dependencies.status {
        DependencyExtractionStatus::Complete => {
            coverage.complete_files = coverage.complete_files.saturating_add(1);
        }
        DependencyExtractionStatus::Unsupported => {
            coverage.unsupported_files = coverage.unsupported_files.saturating_add(1);
        }
        DependencyExtractionStatus::ParserFailed => {
            coverage.parser_failed_files = coverage.parser_failed_files.saturating_add(1);
        }
        DependencyExtractionStatus::Truncated => {
            coverage.truncated_files = coverage.truncated_files.saturating_add(1);
        }
    }
}

fn resolve_reference(
    projection: &mut Projection,
    index: &ResolutionIndex,
    file: &SourceFile,
    reference: &DependencyReference,
    interfaces: Option<&InterfaceFacts>,
) {
    let class = reference_class(reference.kind);
    let Some(kind) = observe_reference_class(projection, class) else {
        if let Some(gap_kind) = class.gap_kind() {
            record_reference_gap(projection, &file.path, reference, gap_kind);
        }
        return;
    };
    let resolution = resolve_edge_reference(index, file, reference);
    let from = index.go.logical_path(file);
    record_resolution(
        projection,
        ResolutionRecord {
            from: &from,
            kind,
            reference,
            interfaces,
            resolution,
        },
    );
}

fn observe_reference_class(projection: &mut Projection, class: ReferenceClass) -> Option<EdgeKind> {
    match class {
        ReferenceClass::Edge(EdgeKind::Runtime) => {
            projection.coverage.runtime_references =
                projection.coverage.runtime_references.saturating_add(1);
            Some(EdgeKind::Runtime)
        }
        ReferenceClass::Edge(EdgeKind::TypeOnly) => {
            projection.coverage.type_references =
                projection.coverage.type_references.saturating_add(1);
            Some(EdgeKind::TypeOnly)
        }
        ReferenceClass::Edge(EdgeKind::Structural) => {
            projection.coverage.structural_references =
                projection.coverage.structural_references.saturating_add(1);
            Some(EdgeKind::Structural)
        }
        ReferenceClass::Unsupported => {
            projection.coverage.unsupported_dynamic_references = projection
                .coverage
                .unsupported_dynamic_references
                .saturating_add(1);
            None
        }
        ReferenceClass::Unresolved => {
            projection.coverage.unresolved_references =
                projection.coverage.unresolved_references.saturating_add(1);
            None
        }
    }
}

fn resolve_edge_reference(
    index: &ResolutionIndex,
    file: &SourceFile,
    reference: &DependencyReference,
) -> Resolution {
    match reference.kind {
        DependencyReferenceKind::NodeRuntime | DependencyReferenceKind::NodeType => {
            resolve_node(&file.path, &reference.specifier, index)
        }
        DependencyReferenceKind::PythonRelative | DependencyReferenceKind::PythonAbsolute => {
            resolve_python(&file.path, reference, index)
        }
        DependencyReferenceKind::RustModule => {
            rust::resolve_module(&file.path, &reference.specifier, &index.rust)
        }
        DependencyReferenceKind::RustUse => {
            rust::resolve_use(&file.path, &reference.specifier, &index.rust)
        }
        DependencyReferenceKind::GoImport => index.go.resolve(&file.path, &reference.specifier),
        _ => Resolution::Unresolved,
    }
}

struct ResolutionRecord<'a> {
    from: &'a RepoPath,
    kind: EdgeKind,
    reference: &'a DependencyReference,
    interfaces: Option<&'a InterfaceFacts>,
    resolution: Resolution,
}

fn record_resolution(projection: &mut Projection, record: ResolutionRecord<'_>) {
    match record.resolution {
        Resolution::Resolved(to) => {
            projection.coverage.resolved_references =
                projection.coverage.resolved_references.saturating_add(1);
            let edge = DependencyEdge {
                from: record.from.clone(),
                to: to.clone(),
                kind: record.kind,
            };
            if !projection.edges.contains(&edge) && projection.edges.len() >= MAX_GRAPH_EDGES {
                projection.coverage.edges_truncated = true;
            } else {
                projection.edges.insert(edge);
            }
            if let Some(interfaces) = record.interfaces {
                record_interface_edge(projection, record.from, &to, record.reference, interfaces);
            }
        }
        Resolution::SameFile => {
            projection.coverage.resolved_references =
                projection.coverage.resolved_references.saturating_add(1);
        }
        Resolution::NodeBuiltin => {
            projection.coverage.node_builtin_references = projection
                .coverage
                .node_builtin_references
                .saturating_add(1);
            projection.coverage.external_references =
                projection.coverage.external_references.saturating_add(1);
            record_reference_gap(
                projection,
                record.from,
                record.reference,
                ResolutionGapKind::NodeBuiltin,
            );
        }
        Resolution::External => {
            projection.coverage.external_references =
                projection.coverage.external_references.saturating_add(1);
            record_reference_gap(
                projection,
                record.from,
                record.reference,
                ResolutionGapKind::External,
            );
        }
        Resolution::Ambiguous => {
            projection.coverage.ambiguous_references =
                projection.coverage.ambiguous_references.saturating_add(1);
            record_reference_gap(
                projection,
                record.from,
                record.reference,
                ResolutionGapKind::Ambiguous,
            );
        }
        Resolution::Unresolved => {
            projection.coverage.unresolved_references =
                projection.coverage.unresolved_references.saturating_add(1);
            record_reference_gap(
                projection,
                record.from,
                record.reference,
                ResolutionGapKind::Unresolved,
            );
        }
    }
}

fn observe_interface_facts(
    projection: &mut Projection,
    file: &SourceFile,
    facts: &FileFacts,
    logical_path: &RepoPath,
    project_interface: bool,
) {
    if !project_interface {
        return;
    }
    let coverage = &mut projection.interface_coverage;
    coverage.files = coverage.files.saturating_add(1);
    update_extraction_coverage(coverage, facts.interfaces.status);
    add_interface_gaps(&mut coverage.gaps, &facts.interfaces.gaps);
    update_surface_coverage(coverage, facts.interfaces.public_surface_status);
    let module = module_interface(file, &facts.interfaces);
    match projection.interfaces.entry(logical_path.clone()) {
        Entry::Vacant(entry) => {
            entry.insert(module);
        }
        Entry::Occupied(mut entry) => merge_module_interface(entry.get_mut(), module),
    }
}

fn merge_module_interface(destination: &mut ModuleInterface, source: ModuleInterface) {
    destination.exports.extend(source.exports);
    destination.shapes.extend(source.shapes);
    destination
        .shape_fingerprints
        .extend(source.shape_fingerprints);
    destination.has_local_exports |= source.has_local_exports;
    destination.has_reexports |= source.has_reexports;
    destination.declaration_file |= source.declaration_file;
    destination.public_surface_complete &= source.public_surface_complete;
}

fn update_extraction_coverage(
    coverage: &mut super::model::InterfaceCoverage,
    status: InterfaceExtractionStatus,
) {
    match status {
        InterfaceExtractionStatus::Complete => {
            coverage.complete_files = coverage.complete_files.saturating_add(1);
        }
        InterfaceExtractionStatus::Partial => {
            coverage.partial_files = coverage.partial_files.saturating_add(1);
        }
        InterfaceExtractionStatus::Unsupported => {
            coverage.unsupported_files = coverage.unsupported_files.saturating_add(1);
        }
        InterfaceExtractionStatus::ParserFailed => {
            coverage.parser_failed_files = coverage.parser_failed_files.saturating_add(1);
        }
        InterfaceExtractionStatus::Truncated => {
            coverage.truncated_files = coverage.truncated_files.saturating_add(1);
        }
    }
}

fn update_surface_coverage(
    coverage: &mut super::model::InterfaceCoverage,
    status: InterfaceSurfaceStatus,
) {
    match status {
        InterfaceSurfaceStatus::Complete => {
            coverage.complete_public_surfaces = coverage.complete_public_surfaces.saturating_add(1);
        }
        InterfaceSurfaceStatus::Partial => {
            coverage.partial_public_surfaces = coverage.partial_public_surfaces.saturating_add(1);
        }
        InterfaceSurfaceStatus::Unsupported => {
            coverage.unsupported_public_surfaces =
                coverage.unsupported_public_surfaces.saturating_add(1);
        }
        InterfaceSurfaceStatus::Truncated => {
            coverage.truncated_public_surfaces =
                coverage.truncated_public_surfaces.saturating_add(1);
        }
    }
}

fn module_interface(file: &SourceFile, facts: &InterfaceFacts) -> ModuleInterface {
    let mut module = ModuleInterface {
        declaration_file: file.language_mode.contains("declaration"),
        public_surface_complete: facts.public_surface_status == InterfaceSurfaceStatus::Complete,
        ..ModuleInterface::default()
    };
    for export in &facts.exports {
        module.exports.insert(InterfaceExportKey {
            namespace: export.namespace,
            name: export.exported_name.clone(),
        });
        match export.origin {
            crate::model::InterfaceExportOrigin::Local => module.has_local_exports = true,
            crate::model::InterfaceExportOrigin::ReExport => module.has_reexports = true,
        }
    }
    module.has_reexports |= facts
        .imports
        .iter()
        .any(|fact| fact.role == InterfaceImportRole::ReExport);
    for shape in &facts.shapes {
        let key = InterfaceShapeKey {
            kind: shape.kind,
            name: shape.exported_name.clone(),
        };
        module.shapes.insert(key.clone(), shape.member_count);
        module
            .shape_fingerprints
            .insert(key, shape.fingerprint.clone());
    }
    module
}

fn record_interface_edge(
    projection: &mut Projection,
    from: &RepoPath,
    target: &RepoPath,
    reference: &DependencyReference,
    facts: &InterfaceFacts,
) {
    let node_reference = match reference.kind {
        DependencyReferenceKind::NodeType
        | DependencyReferenceKind::NodeRuntime
        | DependencyReferenceKind::GoImport => true,
        DependencyReferenceKind::PythonRelative
        | DependencyReferenceKind::PythonAbsolute
        | DependencyReferenceKind::RustModule
        | DependencyReferenceKind::RustUse => false,
        _ => return,
    };
    for fact in facts.imports.iter().filter(|fact| {
        fact.specifier == reference.specifier
            && fact.level == reference.level
            && (node_reference || fact.namespace == InterfaceNamespace::Runtime)
    }) {
        let key = InterfaceEdgeKey {
            from: from.clone(),
            to: target.clone(),
            namespace: fact.namespace,
        };
        match fact.selector.kind {
            InterfaceSelectorKind::Named | InterfaceSelectorKind::Default => {
                let edge = projection.interface_edges.entry(key.clone()).or_default();
                if edge.selectors.contains(&fact.selector) {
                    continue;
                }
                if projection.interface_coverage.resolved_selectors >= MAX_INTERFACE_SELECTORS {
                    projection.interface_coverage.selectors_truncated = true;
                    continue;
                }
                edge.selectors.insert(fact.selector.clone());
                projection.interface_coverage.resolved_selectors = projection
                    .interface_coverage
                    .resolved_selectors
                    .saturating_add(1);
            }
            InterfaceSelectorKind::Namespace => {
                projection
                    .interface_edges
                    .entry(key.clone())
                    .or_default()
                    .unknown_width = true;
            }
            InterfaceSelectorKind::SideEffect => {}
        }
    }
}

enum Resolution {
    Resolved(RepoPath),
    SameFile,
    NodeBuiltin,
    External,
    Ambiguous,
    Unresolved,
}

fn resolve_node(importer: &RepoPath, specifier: &str, index: &ResolutionIndex) -> Resolution {
    if node::is_pinned_builtin(specifier) {
        return Resolution::NodeBuiltin;
    }
    if !is_relative_specifier(specifier) {
        return Resolution::External;
    }
    if specifier.contains(['?', '#', '\\']) {
        return Resolution::Unresolved;
    }
    let Some(base) = normalized_relative(importer, specifier, 0) else {
        return Resolution::Unresolved;
    };
    if strip_language_suffix(&base, Language::TypeScript).is_some()
        || strip_language_suffix(&base, Language::JavaScript).is_some()
    {
        exact_resolution(&base, index, Language::JavaScript.family())
    } else {
        alias_resolution(index.node_aliases.get(&base))
    }
}

fn resolve_python(
    importer: &RepoPath,
    reference: &DependencyReference,
    index: &ResolutionIndex,
) -> Resolution {
    let Some(base) = normalized_python(importer, &reference.specifier, reference.level) else {
        return Resolution::Unresolved;
    };
    alias_resolution(index.python_aliases.get(&base))
}

fn exact_resolution(path: &str, index: &ResolutionIndex, family: &str) -> Resolution {
    let Some(path) = RepoPath::from_protocol(path).ok() else {
        return Resolution::Unresolved;
    };
    index
        .languages
        .get(&path)
        .map_or(Resolution::Unresolved, |language| {
            if language.family() == family {
                Resolution::Resolved(path)
            } else {
                Resolution::Unresolved
            }
        })
}

fn alias_resolution(candidate: Option<&Candidate>) -> Resolution {
    match candidate {
        Some(Candidate::Unique(path)) => Resolution::Resolved(path.clone()),
        Some(Candidate::Ambiguous) => Resolution::Ambiguous,
        None => Resolution::Unresolved,
    }
}

fn normalized_relative(
    importer: &RepoPath,
    specifier: &str,
    extra_parent: usize,
) -> Option<String> {
    let importer = importer.as_utf8()?;
    let mut parts = importer.split('/').collect::<Vec<_>>();
    parts.pop()?;
    for _ in 0..extra_parent {
        parts.pop()?;
    }
    append_normalized(&mut parts, specifier.split('/'))?;
    Some(parts.join("/"))
}

fn normalized_python(importer: &RepoPath, module: &str, level: u32) -> Option<String> {
    if module.is_empty() || module.contains(['/', '\\']) {
        return None;
    }
    if level == 0 {
        if module.contains('.') {
            return None;
        }
        return normalized_relative(importer, module, 0);
    }
    let parents = usize::try_from(level.saturating_sub(1)).ok()?;
    let module_path = module.replace('.', "/");
    normalized_relative(importer, &module_path, parents)
}

fn append_normalized<'a>(
    parts: &mut Vec<&'a str>,
    additions: impl IntoIterator<Item = &'a str>,
) -> Option<()> {
    for part in additions {
        match part {
            "" => return None,
            "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    Some(())
}

fn is_relative_specifier(specifier: &str) -> bool {
    specifier == "."
        || specifier == ".."
        || specifier.starts_with("./")
        || specifier.starts_with("../")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        limits::RuleLimits,
        model::{
            DependencyFacts, DependencyReference, InterfaceExtractionStatus, InterfaceImportFact,
            InterfaceImportRole, InterfaceNamespace, InterfaceSelector, InterfaceSelectorKind,
            InterfaceSurfaceStatus,
        },
    };
    use std::sync::Arc;

    fn source(path: &str, language: Language) -> SourceFile {
        SourceFile::new(
            RepoPath::from_protocol(path).unwrap(),
            format!("// {path}\n").into_bytes(),
            language,
            language.family().into(),
        )
    }

    fn dependency(
        kind: DependencyReferenceKind,
        specifier: &str,
        level: u32,
    ) -> DependencyReference {
        DependencyReference {
            kind,
            specifier: specifier.into(),
            level,
        }
    }

    fn facts_for(
        files: &[SourceFile],
        dependencies: &[(&str, Vec<DependencyReference>)],
        parser_options: &[u8],
    ) -> facts::FactMap {
        files
            .iter()
            .map(|file| {
                let references = dependencies
                    .iter()
                    .find(|(path, _)| file.path.as_utf8() == Some(*path))
                    .map_or_else(Vec::new, |(_, references)| references.clone());
                (
                    facts::key(file, parser_options),
                    Arc::new(FileFacts {
                        dependencies: DependencyFacts {
                            status: DependencyExtractionStatus::Complete,
                            references,
                        },
                        ..FileFacts::default()
                    }),
                )
            })
            .collect()
    }

    fn project_test_pair(
        before: &SourceSnapshot,
        after: &SourceSnapshot,
        file_facts: &facts::FactMap,
        parser_options: &[u8],
    ) -> (Projection, Projection) {
        let interface_paths = before.paths().chain(after.paths()).cloned().collect();
        let go_modules = super::super::engine::GoModuleViews::default();
        let (before_projection, after_projection, _) = project_pair(PairInput {
            before,
            after,
            file_facts,
            parser_options,
            interface_paths: &interface_paths,
            go_modules: &go_modules,
        });
        (before_projection, after_projection)
    }

    fn project_single_dependency(
        files: Vec<SourceFile>,
        importer: &str,
        kind: DependencyReferenceKind,
        specifier: &str,
        level: u32,
    ) -> Projection {
        let parser_options = serde_json::to_vec(&RuleLimits::default()).unwrap();
        let facts = facts_for(
            &files,
            &[(importer, vec![dependency(kind, specifier, level)])],
            &parser_options,
        );
        project(&SourceSnapshot::new(files), &facts, &parser_options)
    }

    #[test]
    fn resolves_only_unique_node_candidates_and_keeps_type_edges_distinct() {
        let files = vec![
            source("src/a.ts", Language::TypeScript),
            source("src/b.ts", Language::TypeScript),
            source("src/c.ts", Language::TypeScript),
            source("src/ambiguous.ts", Language::TypeScript),
            source("src/ambiguous.js", Language::JavaScript),
            source("src/package.ts", Language::TypeScript),
            source("src/package/index.ts", Language::TypeScript),
        ];
        let parser_options = serde_json::to_vec(&RuleLimits::default()).unwrap();
        let facts = facts_for(
            &files,
            &[
                (
                    "src/a.ts",
                    vec![
                        dependency(DependencyReferenceKind::NodeRuntime, "./b", 0),
                        dependency(DependencyReferenceKind::NodeType, "./c", 0),
                        dependency(DependencyReferenceKind::NodeRuntime, "./ambiguous", 0),
                        dependency(DependencyReferenceKind::NodeRuntime, "./package", 0),
                        dependency(DependencyReferenceKind::NodeRuntime, "react", 0),
                        dependency(DependencyReferenceKind::NodeRuntime, "../../../escape", 0),
                        dependency(DependencyReferenceKind::NodeUnsupportedDynamic, "", 0),
                    ],
                ),
                (
                    "src/b.ts",
                    vec![dependency(
                        DependencyReferenceKind::NodeRuntime,
                        "./a.ts",
                        0,
                    )],
                ),
            ],
            &parser_options,
        );
        let projection = project(&SourceSnapshot::new(files), &facts, &parser_options);

        assert_eq!(projection.edges.len(), 3);
        assert!(projection.edges.contains(&DependencyEdge {
            from: RepoPath::from_protocol("src/a.ts").unwrap(),
            to: RepoPath::from_protocol("src/b.ts").unwrap(),
            kind: EdgeKind::Runtime,
        }));
        assert!(projection.edges.contains(&DependencyEdge {
            from: RepoPath::from_protocol("src/a.ts").unwrap(),
            to: RepoPath::from_protocol("src/c.ts").unwrap(),
            kind: EdgeKind::TypeOnly,
        }));
        assert_eq!(projection.coverage.ambiguous_references, 2);
        assert_eq!(projection.coverage.external_references, 1);
        assert_eq!(projection.coverage.unresolved_references, 1);
        assert_eq!(projection.coverage.unsupported_dynamic_references, 1);
    }

    #[test]
    fn resolves_declaration_and_mixed_case_node_suffixes() {
        let files = vec![
            source("src/importer.ts", Language::TypeScript),
            source("src/types.d.ts", Language::TypeScript),
            source("src/EXACT.TS", Language::TypeScript),
        ];
        let parser_options = serde_json::to_vec(&RuleLimits::default()).unwrap();
        let facts = facts_for(
            &files,
            &[(
                "src/importer.ts",
                vec![
                    dependency(DependencyReferenceKind::NodeType, "./types", 0),
                    dependency(DependencyReferenceKind::NodeRuntime, "./EXACT.TS", 0),
                ],
            )],
            &parser_options,
        );
        let projection = project(&SourceSnapshot::new(files), &facts, &parser_options);

        assert_eq!(projection.edges.len(), 2);
        assert_eq!(projection.coverage.unresolved_references, 0);
    }

    #[test]
    fn mixed_node_import_keeps_one_runtime_dependency_and_both_selector_namespaces() {
        let files = vec![
            source("src/importer.ts", Language::TypeScript),
            source("src/target.ts", Language::TypeScript),
        ];
        let parser_options = serde_json::to_vec(&RuleLimits::default()).unwrap();
        let mut file_facts = facts_for(
            &files,
            &[(
                "src/importer.ts",
                vec![dependency(
                    DependencyReferenceKind::NodeRuntime,
                    "./target",
                    0,
                )],
            )],
            &parser_options,
        );
        let importer = &files[0];
        Arc::make_mut(
            file_facts
                .get_mut(&facts::key(importer, &parser_options))
                .unwrap(),
        )
        .interfaces = InterfaceFacts {
            status: InterfaceExtractionStatus::Complete,
            public_surface_status: InterfaceSurfaceStatus::Complete,
            imports: vec![
                InterfaceImportFact {
                    specifier: "./target".into(),
                    level: 0,
                    role: InterfaceImportRole::Import,
                    namespace: InterfaceNamespace::Runtime,
                    selector: InterfaceSelector {
                        kind: InterfaceSelectorKind::Named,
                        name: "value".into(),
                    },
                },
                InterfaceImportFact {
                    specifier: "./target".into(),
                    level: 0,
                    role: InterfaceImportRole::Import,
                    namespace: InterfaceNamespace::TypeOnly,
                    selector: InterfaceSelector {
                        kind: InterfaceSelectorKind::Named,
                        name: "Shape".into(),
                    },
                },
            ],
            ..InterfaceFacts::default()
        };

        let projection = project(&SourceSnapshot::new(files), &file_facts, &parser_options);
        assert_eq!(projection.edges.len(), 1);
        assert_eq!(projection.runtime_edges().count(), 1);
        assert_eq!(projection.interface_edges.len(), 2);
        assert_eq!(projection.interface_coverage.resolved_selectors, 2);
        assert_eq!(
            projection
                .interface_edges
                .iter()
                .map(|(key, edge)| (key.namespace, edge.selectors.len()))
                .collect::<BTreeMap<_, _>>(),
            BTreeMap::from([
                (InterfaceNamespace::Runtime, 1),
                (InterfaceNamespace::TypeOnly, 1),
            ])
        );
    }

    #[test]
    fn resolves_python_sibling_absolute_and_explicit_relative_modules() {
        let files = vec![
            source("pkg/sub/a.py", Language::Python),
            source("pkg/sub/b.py", Language::Python),
            source("pkg/sub/local.pyi", Language::Python),
            source("pkg/tools/__init__.py", Language::Python),
            source("src/lib.rs", Language::Rust),
        ];
        let parser_options = serde_json::to_vec(&RuleLimits::default()).unwrap();
        let facts = facts_for(
            &files,
            &[(
                "pkg/sub/a.py",
                vec![
                    dependency(DependencyReferenceKind::PythonRelative, "b", 1),
                    dependency(DependencyReferenceKind::PythonRelative, "tools", 2),
                    dependency(DependencyReferenceKind::PythonRelative, "local", 1),
                    dependency(DependencyReferenceKind::PythonAbsolute, "b", 0),
                    dependency(DependencyReferenceKind::PythonAbsolute, "requests", 0),
                    dependency(DependencyReferenceKind::PythonAbsolute, "pkg.nested", 0),
                ],
            )],
            &parser_options,
        );
        let projection = project(&SourceSnapshot::new(files), &facts, &parser_options);

        assert_eq!(projection.edges.len(), 3);
        assert_eq!(projection.coverage.resolved_references, 4);
        assert_eq!(projection.coverage.unresolved_references, 2);
        assert_eq!(projection.coverage.external_references, 0);
        assert_eq!(projection.coverage.unsupported_files, 0);
        assert!(projection.resolution_gaps.iter().any(|gap| {
            gap.specifier == "requests" && gap.kind == ResolutionGapKind::Unresolved
        }));
        assert!(projection.resolution_gaps.iter().any(|gap| {
            gap.specifier == "pkg.nested" && gap.kind == ResolutionGapKind::Unresolved
        }));
    }

    #[test]
    fn python_sibling_absolute_imports_record_interface_selectors_like_relative_imports() {
        let files = vec![
            source("pkg/absolute.py", Language::Python),
            source("pkg/relative.py", Language::Python),
            source("pkg/target.py", Language::Python),
        ];
        let parser_options = serde_json::to_vec(&RuleLimits::default()).unwrap();
        let mut file_facts = facts_for(
            &files,
            &[
                (
                    "pkg/absolute.py",
                    vec![dependency(
                        DependencyReferenceKind::PythonAbsolute,
                        "target",
                        0,
                    )],
                ),
                (
                    "pkg/relative.py",
                    vec![dependency(
                        DependencyReferenceKind::PythonRelative,
                        "target",
                        1,
                    )],
                ),
            ],
            &parser_options,
        );
        for (file, level) in [(&files[0], 0), (&files[1], 1)] {
            Arc::make_mut(
                file_facts
                    .get_mut(&facts::key(file, &parser_options))
                    .unwrap(),
            )
            .interfaces = InterfaceFacts {
                status: InterfaceExtractionStatus::Complete,
                public_surface_status: InterfaceSurfaceStatus::Complete,
                imports: vec![InterfaceImportFact {
                    specifier: "target".into(),
                    level,
                    role: InterfaceImportRole::Import,
                    namespace: InterfaceNamespace::Runtime,
                    selector: InterfaceSelector {
                        kind: InterfaceSelectorKind::Named,
                        name: "selected".into(),
                    },
                }],
                ..InterfaceFacts::default()
            };
        }

        let projection = project(&SourceSnapshot::new(files), &file_facts, &parser_options);

        assert_eq!(projection.runtime_edges().count(), 2);
        assert_eq!(projection.interface_edges.len(), 2);
        assert_eq!(projection.interface_coverage.resolved_selectors, 2);
        assert!(projection.interface_edges.values().all(|edge| {
            edge.selectors
                .iter()
                .any(|selector| selector.name == "selected")
        }));
    }

    #[test]
    fn reports_python_sibling_file_package_collisions_as_ambiguous() {
        let projection = project_single_dependency(
            vec![
                source("pkg/a.py", Language::Python),
                source("pkg/target.py", Language::Python),
                source("pkg/target/__init__.py", Language::Python),
            ],
            "pkg/a.py",
            DependencyReferenceKind::PythonAbsolute,
            "target",
            0,
        );

        assert!(projection.edges.is_empty());
        assert_eq!(projection.coverage.ambiguous_references, 1);
        assert_eq!(projection.coverage.unresolved_references, 0);
        assert!(
            projection.resolution_gaps.iter().any(|gap| {
                gap.specifier == "target" && gap.kind == ResolutionGapKind::Ambiguous
            })
        );
    }

    #[test]
    fn resolves_conventional_rust_modules_and_keeps_structural_cycles_non_runtime() {
        let files = vec![
            source("src/lib.rs", Language::Rust),
            source("src/api.rs", Language::Rust),
            source("src/api/service.rs", Language::Rust),
            source("src/shared.rs", Language::Rust),
        ];
        let parser_options = serde_json::to_vec(&RuleLimits::default()).unwrap();
        let facts = facts_for(
            &files,
            &[
                (
                    "src/lib.rs",
                    vec![
                        dependency(DependencyReferenceKind::RustModule, "api", 0),
                        dependency(DependencyReferenceKind::RustModule, "shared", 0),
                    ],
                ),
                (
                    "src/api.rs",
                    vec![
                        dependency(DependencyReferenceKind::RustModule, "service", 0),
                        dependency(DependencyReferenceKind::RustUse, "crate::shared::Value", 0),
                        dependency(DependencyReferenceKind::RustUse, "self::service::Thing", 0),
                        dependency(DependencyReferenceKind::RustUse, "crate::api::Own", 0),
                        dependency(DependencyReferenceKind::RustUse, "serde::Serialize", 0),
                    ],
                ),
                (
                    "src/api/service.rs",
                    vec![dependency(
                        DependencyReferenceKind::RustUse,
                        "super::Sibling",
                        0,
                    )],
                ),
            ],
            &parser_options,
        );

        let projection = project(&SourceSnapshot::new(files), &facts, &parser_options);

        assert_eq!(projection.coverage.complete_files, 4);
        assert_eq!(projection.coverage.structural_references, 8);
        assert_eq!(projection.coverage.resolved_references, 7);
        assert_eq!(projection.coverage.external_references, 1);
        assert_eq!(projection.edges.len(), 5);
        assert_eq!(projection.runtime_edges().count(), 0);
        assert_eq!(projection.dependency_edges().count(), 5);
        assert!(projection.edges.contains(&DependencyEdge {
            from: RepoPath::from_protocol("src/lib.rs").unwrap(),
            to: RepoPath::from_protocol("src/api.rs").unwrap(),
            kind: EdgeKind::Structural,
        }));
        assert!(projection.edges.contains(&DependencyEdge {
            from: RepoPath::from_protocol("src/api/service.rs").unwrap(),
            to: RepoPath::from_protocol("src/api.rs").unwrap(),
            kind: EdgeKind::Structural,
        }));
    }

    #[test]
    fn ambiguous_rust_module_file_forms_never_become_an_edge() {
        let projection = project_single_dependency(
            vec![
                source("src/lib.rs", Language::Rust),
                source("src/duplicate.rs", Language::Rust),
                source("src/duplicate/mod.rs", Language::Rust),
            ],
            "src/lib.rs",
            DependencyReferenceKind::RustModule,
            "duplicate",
            0,
        );

        assert!(projection.edges.is_empty());
        assert_eq!(projection.coverage.ambiguous_references, 1);
    }

    #[test]
    fn rust_orphans_and_undeclared_targets_remain_unresolved() {
        let files = vec![
            source("src/lib.rs", Language::Rust),
            source("src/orphan.rs", Language::Rust),
            source("src/target.rs", Language::Rust),
        ];
        let parser_options = serde_json::to_vec(&RuleLimits::default()).unwrap();
        let facts = facts_for(
            &files,
            &[
                (
                    "src/lib.rs",
                    vec![dependency(DependencyReferenceKind::RustModule, "orphan", 0)],
                ),
                (
                    "src/orphan.rs",
                    vec![dependency(
                        DependencyReferenceKind::RustUse,
                        "crate::target::Value",
                        0,
                    )],
                ),
            ],
            &parser_options,
        );

        let projection = project(&SourceSnapshot::new(files), &facts, &parser_options);

        assert_eq!(projection.edges.len(), 1);
        assert_eq!(projection.coverage.resolved_references, 1);
        assert_eq!(projection.coverage.unresolved_references, 1);
        assert!(projection.edges.contains(&DependencyEdge {
            from: RepoPath::from_protocol("src/lib.rs").unwrap(),
            to: RepoPath::from_protocol("src/orphan.rs").unwrap(),
            kind: EdgeKind::Structural,
        }));
    }

    #[test]
    fn custom_rust_roots_are_not_guessed_without_project_context() {
        let projection = project_single_dependency(
            vec![
                source("custom/entry.rs", Language::Rust),
                source("custom/entry/child.rs", Language::Rust),
            ],
            "custom/entry.rs",
            DependencyReferenceKind::RustModule,
            "child",
            0,
        );

        assert!(projection.edges.is_empty());
        assert_eq!(projection.coverage.unresolved_references, 1);
    }

    #[test]
    fn pair_projection_reuses_only_when_target_universe_is_unchanged() {
        let parser_options = serde_json::to_vec(&RuleLimits::default()).unwrap();
        let old_a = source("src/a.ts", Language::TypeScript);
        let new_a = SourceFile::new(
            RepoPath::from_protocol("src/a.ts").unwrap(),
            b"// changed a\n".as_slice(),
            Language::TypeScript,
            "node".into(),
        );
        let b = source("src/b.ts", Language::TypeScript);
        let c = source("src/c.ts", Language::TypeScript);
        let before_files = vec![old_a.clone(), b.clone(), c.clone()];
        let after_files = vec![new_a.clone(), b, c];
        let mut file_facts = facts_for(
            &before_files,
            &[(
                "src/a.ts",
                vec![dependency(DependencyReferenceKind::NodeRuntime, "./b", 0)],
            )],
            &parser_options,
        );
        file_facts.extend(facts_for(
            &after_files,
            &[(
                "src/a.ts",
                vec![dependency(DependencyReferenceKind::NodeRuntime, "./c", 0)],
            )],
            &parser_options,
        ));
        let before = SourceSnapshot::new(before_files);
        let after = SourceSnapshot::new(after_files);
        let (_, incremental) = project_test_pair(&before, &after, &file_facts, &parser_options);
        let full = project(&after, &file_facts, &parser_options);
        assert_projection_eq(&incremental, &full);

        let typescript_target = source("src/target.ts", Language::TypeScript);
        let javascript_target = source("src/target.js", Language::JavaScript);
        let importer = source("src/importer.ts", Language::TypeScript);
        let before_files = vec![importer.clone(), typescript_target.clone()];
        let after_files = vec![importer, typescript_target, javascript_target];
        let file_facts = facts_for(
            &after_files,
            &[(
                "src/importer.ts",
                vec![dependency(
                    DependencyReferenceKind::NodeRuntime,
                    "./target",
                    0,
                )],
            )],
            &parser_options,
        );
        let before = SourceSnapshot::new(before_files);
        let after = SourceSnapshot::new(after_files);
        let (_, projected) = project_test_pair(&before, &after, &file_facts, &parser_options);
        assert!(projected.edges.is_empty());
        assert_eq!(projected.coverage.ambiguous_references, 1);
    }

    #[test]
    fn incremental_projection_requires_stable_topology_and_complete_change_paths() {
        let baseline = SourceSnapshot::new([
            source("src/a.ts", Language::TypeScript),
            source("src/b.py", Language::Python),
        ]);
        let content_only = SourceSnapshot::new([
            SourceFile::new(
                RepoPath::from_protocol("src/a.ts").unwrap(),
                b"// changed\n".as_slice(),
                Language::TypeScript,
                "node".into(),
            ),
            source("src/b.py", Language::Python),
        ]);
        let changed = BTreeSet::from([RepoPath::from_protocol("src/a.ts").unwrap()]);
        assert!(can_incrementally_project(
            &baseline,
            &content_only,
            &changed
        ));
        assert!(!can_incrementally_project(
            &baseline,
            &content_only,
            &BTreeSet::new()
        ));

        let language_changed = SourceSnapshot::new([
            source("src/a.ts", Language::JavaScript),
            source("src/b.py", Language::Python),
        ]);
        assert!(!can_incrementally_project(
            &baseline,
            &language_changed,
            &changed
        ));

        let path_changed = SourceSnapshot::new([
            source("src/a.ts", Language::TypeScript),
            source("src/c.py", Language::Python),
        ]);
        assert!(!can_incrementally_project(
            &baseline,
            &path_changed,
            &changed
        ));
    }

    fn assert_projection_eq(left: &Projection, right: &Projection) {
        assert_eq!(left.nodes, right.nodes);
        assert_eq!(left.edges, right.edges);
        assert_eq!(left.coverage, right.coverage);
        assert_eq!(left.interface_coverage, right.interface_coverage);
        assert_eq!(
            left.interfaces.keys().collect::<Vec<_>>(),
            right.interfaces.keys().collect::<Vec<_>>()
        );
        assert_eq!(
            left.interface_edges.keys().collect::<Vec<_>>(),
            right.interface_edges.keys().collect::<Vec<_>>()
        );
        for key in left.interface_edges.keys() {
            let left_edge = &left.interface_edges[key];
            let right_edge = &right.interface_edges[key];
            assert_eq!(left_edge.selectors, right_edge.selectors);
            assert_eq!(left_edge.unknown_width, right_edge.unknown_width);
        }
    }
}

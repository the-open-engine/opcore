use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{
    model::{
        CallableKind, InterfaceExportNamespace, InterfaceGapCounts, InterfaceNamespace,
        InterfaceSelector, InterfaceShapeKind, SourceRange,
    },
    path::RepoPath,
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    Runtime,
    TypeOnly,
    Structural,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionGapKind {
    NodeBuiltin,
    External,
    Ambiguous,
    Unresolved,
    UnsupportedDynamic,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionGapEvidence {
    pub path: RepoPath,
    pub specifier: String,
    pub kind: ResolutionGapKind,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyEdge {
    pub from: RepoPath,
    pub to: RepoPath,
    pub kind: EdgeKind,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntroducedCycle {
    pub member_count: usize,
    pub members: Vec<RepoPath>,
    pub members_truncated: bool,
    pub trigger: DependencyEdge,
    pub witness: Vec<RepoPath>,
    pub witness_truncated: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DuplicateKind {
    IdenticalFile,
    CallableBody,
    TokenRegion,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateOccurrence {
    pub path: RepoPath,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callable_kind: Option<CallableKind>,
    pub changed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntroducedDuplicate {
    pub class_id: String,
    pub kind: DuplicateKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language_family: Option<String>,
    pub before_count: usize,
    pub after_count: usize,
    pub introduced_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_count: Option<usize>,
    pub occurrences: Vec<DuplicateOccurrence>,
    pub occurrences_truncated: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FingerprintCoverage {
    pub files: usize,
    pub complete_files: usize,
    pub unsupported_files: usize,
    pub parser_failed_files: usize,
    pub truncated_files: usize,
    pub callable_occurrences: usize,
    pub region_anchors: usize,
    pub region_tokens: usize,
    pub request_truncated: bool,
    #[serde(default)]
    pub malformed_evidence: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupCoverage {
    pub before: FingerprintCoverage,
    pub after: FingerprintCoverage,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionCoverage {
    pub files: usize,
    pub complete_files: usize,
    pub unsupported_files: usize,
    pub parser_failed_files: usize,
    pub truncated_files: usize,
    pub runtime_references: usize,
    pub type_references: usize,
    pub structural_references: usize,
    pub resolved_references: usize,
    #[serde(default)]
    pub node_builtin_references: usize,
    pub external_references: usize,
    pub ambiguous_references: usize,
    pub unresolved_references: usize,
    pub unsupported_dynamic_references: usize,
    pub configuration_errors: usize,
    pub edges_truncated: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceCoverage {
    pub files: usize,
    pub complete_files: usize,
    pub partial_files: usize,
    pub unsupported_files: usize,
    pub parser_failed_files: usize,
    pub truncated_files: usize,
    pub complete_public_surfaces: usize,
    pub partial_public_surfaces: usize,
    pub unsupported_public_surfaces: usize,
    pub truncated_public_surfaces: usize,
    pub resolved_selectors: usize,
    pub selectors_truncated: bool,
    pub gaps: InterfaceGapCounts,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveSensePolicy {
    pub minimum_identical_bytes: usize,
    pub minimum_callable_tokens: usize,
    pub minimum_region_tokens: usize,
    pub max_dependency_targets: usize,
    pub max_edge_selectors: usize,
    pub max_module_exports: usize,
    pub max_shape_members: usize,
    pub important_fan_in: usize,
    pub documentation_registry: String,
    pub excluded_paths: Vec<RepoPath>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceFinding {
    pub code: String,
    pub path: RepoPath,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<RepoPath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity: Option<String>,
    pub metric: String,
    pub before: usize,
    pub after: usize,
    pub limit: usize,
    pub basis: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[expect(
    clippy::struct_excessive_bools,
    reason = "the stable report schema exposes these independent before/after evidence facts"
)]
pub struct InterfaceDelta {
    pub path: RepoPath,
    pub deleted: bool,
    pub before_public_surface_authoritative: bool,
    pub after_public_surface_authoritative: bool,
    pub public_surface_changed: bool,
    pub before_dependency_targets: usize,
    pub after_dependency_targets: usize,
    pub before_exports: usize,
    pub after_exports: usize,
    pub before_max_edge_selectors: usize,
    pub after_max_edge_selectors: usize,
    pub before_max_shape_members: usize,
    pub after_max_shape_members: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[expect(
    clippy::struct_excessive_bools,
    reason = "the stable report schema exposes independent importance and coverage facts"
)]
pub struct ImportantNodeObservation {
    pub path: RepoPath,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_path: Option<RepoPath>,
    pub deleted: bool,
    pub before_confirmed_dependency_fan_in: usize,
    pub after_confirmed_dependency_fan_in: usize,
    pub before_explicit_exports: usize,
    pub after_explicit_exports: usize,
    pub before_public_surface_authoritative: bool,
    pub after_public_surface_authoritative: bool,
    pub newly_important: bool,
    pub public_surface_changed: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentationReason {
    NewlyImportant,
    PublicSurfaceChanged,
    Renamed,
    Deleted,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentationRequirement {
    pub code: String,
    pub path: RepoPath,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_path: Option<RepoPath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document: Option<RepoPath>,
    pub reasons: Vec<DocumentationReason>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentationRegistryState {
    #[default]
    NotRead,
    Missing,
    Valid,
    Invalid,
    Unavailable,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentationCoverage {
    pub evaluated: bool,
    pub before_registry: DocumentationRegistryState,
    pub after_registry: DocumentationRegistryState,
    pub before_bindings: usize,
    pub after_bindings: usize,
    pub documents_requested: usize,
    pub before_documents: usize,
    pub after_documents: usize,
    pub changed_documents: usize,
    pub public_surface_candidates: usize,
    pub authoritative_public_surfaces: usize,
    pub unavailable_public_surfaces: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectDependencyDelta {
    pub path: RepoPath,
    pub deleted: bool,
    pub before_runtime: usize,
    pub after_runtime: usize,
    pub runtime_delta: i64,
    pub before_type_only: usize,
    pub after_type_only: usize,
    pub type_only_delta: i64,
    pub before_structural: usize,
    pub after_structural: usize,
    pub structural_delta: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactObservation {
    pub path: RepoPath,
    pub deleted: bool,
    pub confirmed_direct_dependents: usize,
    pub confirmed_reachable_dependents: usize,
    pub reachable_count_is_lower_bound: bool,
    pub sample: Vec<RepoPath>,
    pub sample_truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HighImpactChange {
    pub path: RepoPath,
    pub confirmed_direct_dependents: usize,
    pub threshold: usize,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenseObservations {
    pub dependency_deltas: Vec<DirectDependencyDelta>,
    pub impact: Vec<ImpactObservation>,
    pub high_impact_changes: Vec<HighImpactChange>,
    pub interfaces: Vec<InterfaceDelta>,
    pub important_nodes: Vec<ImportantNodeObservation>,
    pub impact_truncated: bool,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SenseStatus {
    Clean,
    Findings,
    Partial,
    Incomplete,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DedupLimitStage {
    CallableFileExtraction,
    TokenRegionFileExtraction,
    CallableRequestCollection,
    TokenRegionRequestCollection,
    ExactTokenComparison,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SenseView {
    Before,
    After,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenseIssue {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<DedupLimitStage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub views: Vec<SenseView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processed: Option<usize>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub processed_is_lower_bound: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<RepoPath>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub paths_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_step: Option<String>,
}

impl SenseIssue {
    pub(crate) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            stage: None,
            views: Vec::new(),
            limit: None,
            processed: None,
            processed_is_lower_bound: false,
            paths: Vec::new(),
            paths_truncated: false,
            next_step: None,
        }
    }
}

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde skip_serializing_if requires a reference-taking predicate"
)]
const fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphViewSummary {
    pub view_id: String,
    pub files: usize,
    pub runtime_edges: usize,
    pub type_only_edges: usize,
    pub structural_edges: usize,
    pub coverage: ResolutionCoverage,
    #[serde(default)]
    pub resolution_gaps: Vec<ResolutionGapEvidence>,
    #[serde(default)]
    pub resolution_gaps_truncated: bool,
    pub interface_edges: usize,
    pub interface_coverage: InterfaceCoverage,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenseTiming {
    pub total_us: u64,
    pub capture_us: u64,
    pub facts_us: u64,
    pub resolution_us: u64,
    pub cycles_us: u64,
    pub observations_us: u64,
    pub dedup_us: u64,
    pub documentation_us: u64,
    pub render_us: u64,
    pub unique_files_analyzed: usize,
    pub unique_source_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenseReport {
    pub status: SenseStatus,
    pub issues: Vec<SenseIssue>,
    pub introduced_cycles: Vec<IntroducedCycle>,
    pub introduced_duplicates: Vec<IntroducedDuplicate>,
    pub interface_findings: Vec<InterfaceFinding>,
    pub documentation_requirements: Vec<DocumentationRequirement>,
    pub findings_truncated: bool,
    pub dedup_coverage: DedupCoverage,
    pub documentation_coverage: DocumentationCoverage,
    pub observations: SenseObservations,
    pub effective_policy: EffectiveSensePolicy,
    pub before: GraphViewSummary,
    pub after: GraphViewSummary,
    pub changed_files: usize,
    pub valid_as_of: String,
    pub provider: crate::model::ProviderMetadata,
    pub timing: SenseTiming,
    pub cache: crate::model::CacheMetadata,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Projection {
    pub nodes: BTreeSet<RepoPath>,
    pub edges: BTreeSet<DependencyEdge>,
    pub coverage: ResolutionCoverage,
    pub resolution_gaps: BTreeSet<ResolutionGapEvidence>,
    pub resolution_gaps_truncated: bool,
    pub interfaces: BTreeMap<RepoPath, ModuleInterface>,
    pub interface_edges: BTreeMap<InterfaceEdgeKey, InterfaceEdge>,
    pub interface_coverage: InterfaceCoverage,
}

impl Projection {
    pub fn runtime_edges(&self) -> impl Iterator<Item = &DependencyEdge> {
        self.edges
            .iter()
            .filter(|edge| edge.kind == EdgeKind::Runtime)
    }

    pub fn dependency_edges(&self) -> impl Iterator<Item = &DependencyEdge> {
        self.edges
            .iter()
            .filter(|edge| edge.kind != EdgeKind::TypeOnly)
    }
}

#[derive(Clone, Debug, Default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "module extraction retains four independent parser facts without allocation"
)]
pub(crate) struct ModuleInterface {
    pub exports: BTreeSet<InterfaceExportKey>,
    pub shapes: BTreeMap<InterfaceShapeKey, usize>,
    pub shape_fingerprints: BTreeMap<InterfaceShapeKey, String>,
    pub has_local_exports: bool,
    pub has_reexports: bool,
    pub declaration_file: bool,
    pub public_surface_complete: bool,
}

impl ModuleInterface {
    pub fn pure_barrel(&self) -> bool {
        self.has_reexports && !self.has_local_exports
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct InterfaceExportKey {
    pub namespace: InterfaceExportNamespace,
    pub name: String,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct InterfaceShapeKey {
    pub kind: InterfaceShapeKind,
    pub name: String,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct InterfaceEdgeKey {
    pub from: RepoPath,
    pub to: RepoPath,
    pub namespace: InterfaceNamespace,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct InterfaceEdge {
    pub selectors: BTreeSet<InterfaceSelector>,
    pub unknown_width: bool,
}

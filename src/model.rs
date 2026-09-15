use std::{collections::BTreeMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};

use crate::{identity::ContentId, path::RepoPath};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Comparison {
    Introduced,
    All,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Scope {
    Changeset,
    Workspace,
    Paths { paths: Vec<RepoPath> },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    JavaScript,
    TypeScript,
    Rust,
    Python,
    Go,
    Hcl,
    Shell,
    Protobuf,
}

impl Language {
    #[must_use]
    pub const fn family(self) -> &'static str {
        match self {
            Self::JavaScript | Self::TypeScript => "node",
            Self::Rust => "rust",
            Self::Python => "python",
            Self::Go => "go",
            Self::Hcl => "hcl",
            Self::Shell => "shell",
            Self::Protobuf => "protobuf",
        }
    }
}

#[derive(Clone, Debug)]
pub struct SourceFile {
    pub path: RepoPath,
    pub bytes: Arc<[u8]>,
    pub content_id: ContentId,
    pub language: Language,
    pub language_mode: String,
}

impl SourceFile {
    #[must_use]
    pub fn new(
        path: RepoPath,
        bytes: impl Into<Arc<[u8]>>,
        language: Language,
        language_mode: String,
    ) -> Self {
        let bytes = bytes.into();
        let content_id = ContentId::of(&bytes);
        Self {
            path,
            bytes,
            content_id,
            language,
            language_mode,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub line: u32,
    pub column: u32,
    pub byte: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRange {
    pub start: Position,
    pub end: Position,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub rule_id: String,
    pub severity: Severity,
    pub message: String,
    pub path: RepoPath,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    pub fingerprint: String,
    pub language: Language,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub evidence: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawDiagnostic {
    pub rule_id: String,
    pub severity: Severity,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    pub entity_key: String,
    pub cause_key: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub evidence: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFacts {
    pub diagnostics: Vec<RawDiagnostic>,
    pub parser: String,
    pub parser_version: String,
    #[serde(default)]
    pub dependencies: DependencyFacts,
    #[serde(default)]
    pub callable_fingerprints: CallableFingerprintFacts,
    #[serde(default)]
    pub region_fingerprints: RegionFingerprintFacts,
    #[serde(default)]
    pub interfaces: InterfaceFacts,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallableFingerprintFacts {
    pub status: FingerprintExtractionStatus,
    pub callables: Vec<CallableFingerprint>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionFingerprintFacts {
    pub status: FingerprintExtractionStatus,
    pub token_count: u32,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub encoded_tokens: String,
    pub anchors: Vec<RegionFingerprint>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceFacts {
    pub status: InterfaceExtractionStatus,
    pub public_surface_status: InterfaceSurfaceStatus,
    pub imports: Vec<InterfaceImportFact>,
    pub exports: Vec<InterfaceExportFact>,
    pub shapes: Vec<InterfaceShapeFact>,
    pub gaps: InterfaceGapCounts,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FingerprintExtractionStatus {
    Complete,
    Truncated,
    ParserFailed,
    #[default]
    Unsupported,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InterfaceSurfaceStatus {
    Complete,
    Partial,
    Truncated,
    #[default]
    Unsupported,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InterfaceExtractionStatus {
    Complete,
    Partial,
    Truncated,
    ParserFailed,
    #[default]
    Unsupported,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CallableKind {
    Function,
    Method,
    Arrow,
    Closure,
    Lambda,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceImportFact {
    pub specifier: String,
    #[serde(default)]
    pub level: u32,
    pub role: InterfaceImportRole,
    pub namespace: InterfaceNamespace,
    pub selector: InterfaceSelector,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InterfaceImportRole {
    Import,
    ReExport,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InterfaceNamespace {
    Runtime,
    TypeOnly,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallableFingerprint {
    pub kind: CallableKind,
    pub range: SourceRange,
    pub token_count: u32,
    pub token_line_count: u32,
    pub digest: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionFingerprint {
    pub hash_one: u64,
    pub hash_two: u64,
    pub token_index: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceSelector {
    pub kind: InterfaceSelectorKind,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InterfaceSelectorKind {
    Named,
    Default,
    Namespace,
    SideEffect,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceExportFact {
    pub exported_name: String,
    pub namespace: InterfaceExportNamespace,
    pub origin: InterfaceExportOrigin,
    pub declaration_kind: InterfaceDeclarationKind,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InterfaceExportNamespace {
    Value,
    TypeOnly,
    Namespace,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InterfaceExportOrigin {
    Local,
    ReExport,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InterfaceDeclarationKind {
    Function,
    Method,
    Class,
    Variable,
    Constant,
    Struct,
    Interface,
    TypeAlias,
    Enum,
    DefaultExpression,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceShapeFact {
    pub exported_name: String,
    pub kind: InterfaceShapeKind,
    pub member_count: usize,
    pub fingerprint: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InterfaceShapeKind {
    Interface,
    Struct,
    TypeLiteralAlias,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceGapCounts {
    pub wildcard_exports: usize,
    pub namespace_imports: usize,
    pub common_js_exports: usize,
    pub dynamic_loaders: usize,
    pub unsupported_patterns: usize,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyFacts {
    pub status: DependencyExtractionStatus,
    pub references: Vec<DependencyReference>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyExtractionStatus {
    Complete,
    Truncated,
    ParserFailed,
    #[default]
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyReference {
    pub kind: DependencyReferenceKind,
    pub specifier: String,
    #[serde(default)]
    pub level: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyReferenceKind {
    NodeRuntime,
    NodeType,
    NodeUnsupportedDynamic,
    PythonRelative,
    PythonUnsupportedRelative,
    PythonAbsolute,
    RustModule,
    RustUse,
    RustUnsupported,
    GoImport,
    GoUnsupportedImport,
    GoUnsupportedConditional,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverageStatus {
    NotChecked,
    Unsupported,
    Incomplete,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageGap {
    pub path: RepoPath,
    pub status: CoverageStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<Language>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub files_considered: usize,
    pub files_covered: usize,
    pub gaps: Vec<CoverageGap>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssessmentStatus {
    Clean,
    Findings,
    NotChecked,
    Incomplete,
    Unsupported,
    Cancelled,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Assessment {
    pub status: AssessmentStatus,
    pub diagnostics: Vec<Diagnostic>,
    pub coverage: Coverage,
    pub valid_as_of: String,
    pub provider: ProviderMetadata,
    pub timing: Timing,
    pub cache: CacheMetadata,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderMetadata {
    pub name: String,
    pub version: String,
    pub fact_abi: String,
}

impl Default for ProviderMetadata {
    fn default() -> Self {
        Self {
            name: "opcore".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            fact_abi: crate::analysis::FACT_ABI.into(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    pub duration_ms: u64,
    pub files_read: usize,
    pub files_parsed: usize,
}

impl Timing {
    #[must_use]
    pub fn with_duration(mut self, duration: Duration) -> Self {
        self.duration_ms = u64::try_from(duration.as_millis()).unwrap_or(u64::MAX);
        self
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheMetadata {
    pub state: String,
    pub hits: usize,
    pub misses: usize,
    pub writes: usize,
}

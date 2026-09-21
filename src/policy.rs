//! One strict, bounded repository configuration shared by local commands and providers.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use clap::ValueEnum;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    documentation::validate_bindings,
    json::parse_unique_json,
    limits::{
        MAX_DEPENDENCY_FACTS_PER_FILE, MAX_FILES, MAX_GRAPH_EDGES, MAX_INTERFACE_FACTS_PER_FILE,
        MAX_LINE_BYTES, MAX_SOURCE_BYTES, MAX_STRUCTURAL_DEPTH, RuleLimits,
    },
    path::RepoPath,
    sense::SenseOptions,
    source::git::{GitAuxiliaryCapture, GitRepository},
};

mod schema;
mod settings;
mod shape;
pub use schema::schema;
pub use settings::*;

pub const POLICY_PATH: &str = ".opcore.json";
pub const POLICY_SCHEMA_VERSION: u32 = 1;
pub const MAX_POLICY_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
/// A built-in check workflow with repository-defined settings.
pub enum Workflow {
    /// Fast Verify and Sense against the current worktree.
    PostEdit,
    /// Full staged Verify and selected native checks, plus introduced Sense.
    PreCommit,
    /// Full immutable-commit Verify and native checks, plus Sense against a base commit.
    Ci,
}

impl Workflow {
    /// Returns the stable command-line and configuration name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PostEdit => "post-edit",
            Self::PreCommit => "pre-commit",
            Self::Ci => "ci",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "ref")]
pub enum ConfigView {
    Worktree,
    Index,
    Tree(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Policy {
    pub schema_version: u32,
    #[serde(default)]
    pub verify: RuleLimits,
    #[serde(default)]
    pub sense: SensePolicy,
    #[serde(default)]
    pub documentation: DocumentationSettings,
    #[serde(default)]
    pub targets: TargetPolicy,
    #[serde(default)]
    pub providers: ProviderSettings,
    #[serde(default)]
    pub native: Vec<NativeProvider>,
    #[serde(default)]
    pub coverage: CoveragePolicy,
    #[serde(default, skip_serializing_if = "Workflows::is_empty")]
    pub workflows: Workflows,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            schema_version: POLICY_SCHEMA_VERSION,
            verify: RuleLimits::default(),
            sense: SensePolicy::default(),
            documentation: DocumentationSettings::default(),
            targets: TargetPolicy::default(),
            providers: ProviderSettings::default(),
            native: Vec::new(),
            coverage: CoveragePolicy::default(),
            workflows: Workflows::default(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct SensePolicy {
    pub important_fan_in: usize,
    pub minimum_identical_bytes: usize,
    pub max_dependency_targets: usize,
    pub max_edge_selectors: usize,
    pub max_module_exports: usize,
    pub max_shape_members: usize,
}

impl Default for SensePolicy {
    fn default() -> Self {
        let defaults = SenseOptions::default();
        Self {
            important_fan_in: defaults.high_impact_threshold,
            minimum_identical_bytes: defaults.minimum_identical_bytes,
            max_dependency_targets: defaults.max_dependency_targets,
            max_edge_selectors: defaults.max_edge_selectors,
            max_module_exports: defaults.max_module_exports,
            max_shape_members: defaults.max_shape_members,
        }
    }
}

impl Policy {
    #[must_use]
    pub fn sense_options(&self) -> SenseOptions {
        SenseOptions {
            limits: self.verify,
            high_impact_threshold: self.sense.important_fan_in,
            minimum_identical_bytes: self.sense.minimum_identical_bytes,
            max_dependency_targets: self.sense.max_dependency_targets,
            max_edge_selectors: self.sense.max_edge_selectors,
            max_module_exports: self.sense.max_module_exports,
            max_shape_members: self.sense.max_shape_members,
        }
    }

    pub fn resolve(&self, workflow: Option<Workflow>) -> Result<Self> {
        let mut resolved = self.clone();
        if let Some(workflow) = workflow {
            let settings = self.workflows.selected(workflow);
            settings.verify.apply(&mut resolved.verify);
            settings.sense.apply(&mut resolved.sense);
            settings.targets.apply(&mut resolved.targets);
            settings.providers.apply(&mut resolved.providers);
            settings.coverage.apply(&mut resolved.coverage);
            if let Some(native) = &settings.native {
                resolved.native.clone_from(native);
            }
            if workflow == Workflow::PostEdit {
                ensure!(
                    settings.native.as_ref().is_none_or(Vec::is_empty),
                    "workflows.post-edit.native must be empty: automatic hooks use Fast Verify and Sense"
                );
                resolved.native.clear();
            }
        }
        resolved.workflows = Workflows::default();
        resolved.validate_effective()?;
        Ok(resolved)
    }

    fn validate(&self) -> Result<()> {
        self.validate_effective()?;
        for workflow in [Workflow::PostEdit, Workflow::PreCommit, Workflow::Ci] {
            self.resolve(Some(workflow))
                .with_context(|| format!("workflows.{}", workflow.as_str()))?;
        }
        Ok(())
    }

    fn validate_effective(&self) -> Result<()> {
        ensure!(
            self.schema_version == POLICY_SCHEMA_VERSION,
            "schemaVersion must be {POLICY_SCHEMA_VERSION}"
        );
        validate_verify(&self.verify)?;
        ensure!(
            (1..=MAX_SOURCE_BYTES).contains(&self.sense.minimum_identical_bytes),
            "sense.minimumIdenticalBytes must be within 1..={MAX_SOURCE_BYTES}"
        );
        ensure!(
            (1..=MAX_FILES).contains(&self.sense.important_fan_in),
            "sense.importantFanIn must be within 1..={MAX_FILES}"
        );
        ensure!(
            self.sense.max_dependency_targets <= MAX_GRAPH_EDGES,
            "sense.maxDependencyTargets exceeds the graph safety bound"
        );
        for (name, value) in [
            ("maxEdgeSelectors", self.sense.max_edge_selectors),
            ("maxModuleExports", self.sense.max_module_exports),
            ("maxShapeMembers", self.sense.max_shape_members),
        ] {
            ensure!(
                value <= MAX_INTERFACE_FACTS_PER_FILE,
                "sense.{name} exceeds the per-file fact bound"
            );
        }
        self.targets.validate()?;
        self.providers.validate()?;
        validate_bindings(&self.documentation.bindings)?;
        ensure!(
            self.native.iter().collect::<BTreeSet<_>>().len() == self.native.len(),
            "native contains a duplicate provider"
        );
        for provider in &self.native {
            ensure!(
                !self.providers.options(*provider).roots.is_empty(),
                "providers.{}.roots cannot be empty while that native provider is required",
                provider.as_str()
            );
        }
        Ok(())
    }
}

pub fn validate_verify(limits: &RuleLimits) -> Result<()> {
    ensure!(
        limits.max_file_lines as usize <= MAX_SOURCE_BYTES,
        "verify.maxFileLines exceeds the hard safety bound"
    );
    ensure!(
        limits.max_line_bytes as usize <= MAX_LINE_BYTES,
        "verify.maxLineBytes exceeds the hard safety bound"
    );
    ensure!(
        limits.max_function_lines <= limits.max_file_lines,
        "verify.maxFunctionLines must not exceed maxFileLines"
    );
    ensure!(
        limits.max_parameters as usize <= MAX_DEPENDENCY_FACTS_PER_FILE,
        "verify.maxParameters exceeds the hard safety bound"
    );
    ensure!(
        limits.max_nesting as usize <= MAX_STRUCTURAL_DEPTH,
        "verify.maxNesting exceeds the parser safety bound"
    );
    ensure!(
        limits.max_cyclomatic_complexity as usize <= MAX_SOURCE_BYTES,
        "verify.maxCyclomaticComplexity exceeds the hard safety bound"
    );
    Ok(())
}

pub fn parse_policy(bytes: &[u8]) -> Result<Policy> {
    ensure!(
        bytes.len() <= MAX_POLICY_BYTES,
        "{POLICY_PATH} exceeds {MAX_POLICY_BYTES} bytes"
    );
    let mut value =
        parse_unique_json(bytes).with_context(|| format!("parse unique {POLICY_PATH} JSON"))?;
    shape::validate(&value)?;
    if let Some(object) = value.as_object_mut()
        && let Some(schema) = object.remove("$schema")
    {
        ensure!(schema.is_string(), "$schema must be a schema URL string");
    }
    let mut policy: Policy =
        serde_json::from_value(value).with_context(|| format!("validate {POLICY_PATH} schema"))?;
    policy.documentation.bindings.sort();
    policy
        .validate()
        .with_context(|| format!("validate {POLICY_PATH} settings"))?;
    Ok(policy)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyState {
    Default,
    Configured,
}

#[derive(Clone, Debug)]
pub struct PolicySnapshot {
    pub policy: Policy,
    pub state: PolicyState,
    pub digest: String,
    pub workflow: Option<Workflow>,
    pub view: ConfigView,
    pub origins: BTreeMap<String, String>,
    root: PathBuf,
    bytes: Option<Vec<u8>>,
    capture: Option<GitAuxiliaryCapture>,
}

impl PolicySnapshot {
    pub(crate) fn report_configuration(&self) -> Value {
        json!({
            "state": self.state,
            "view": self.view,
            "digest": self.digest,
            "effective": self.policy,
            "origins": self.origins,
        })
    }

    #[cfg(test)]
    pub fn load(root: &Path) -> Result<Self> {
        let bytes = stable_read(&root.join(POLICY_PATH))?;
        Self::from_bytes(root, bytes, ConfigView::Worktree, None, None)
    }

    pub fn capture(
        repository: &GitRepository,
        view: ConfigView,
        workflow: Option<Workflow>,
    ) -> Result<Self> {
        let path = RepoPath::from_protocol(POLICY_PATH)?;
        let paths = BTreeSet::from([path.clone()]);
        let capture = match &view {
            ConfigView::Worktree => repository.capture_auxiliary(&paths)?,
            ConfigView::Index => repository.capture_staged_auxiliary(&paths)?,
            ConfigView::Tree(reference) => {
                repository.capture_tree_auxiliary(&paths, reference, None)?
            }
        };
        let state = capture
            .paths
            .get(&path)
            .context("configuration capture omitted requested path")?;
        let bytes = state.after.as_ref().map(|blob| blob.bytes.to_vec());
        Self::from_bytes(repository.root(), bytes, view, workflow, Some(capture))
    }

    fn from_bytes(
        root: &Path,
        bytes: Option<Vec<u8>>,
        view: ConfigView,
        workflow: Option<Workflow>,
        capture: Option<GitAuxiliaryCapture>,
    ) -> Result<Self> {
        let configured = bytes
            .as_ref()
            .map(|bytes| parse_policy(bytes))
            .transpose()?;
        let state = if configured.is_some() {
            PolicyState::Configured
        } else {
            PolicyState::Default
        };
        let mut configuration = configured.unwrap_or_default();
        if workflow == Some(Workflow::PostEdit) {
            let explicit = bytes
                .as_ref()
                .map(|bytes| parse_unique_json(bytes))
                .transpose()?;
            if explicit
                .as_ref()
                .and_then(|value| value.get("coverage"))
                .and_then(|value| value.get("allowPartial"))
                .is_none()
            {
                configuration.coverage.allow_partial = true;
            }
        }
        let policy = configuration.resolve(workflow)?;
        let canonical = serde_json::to_vec(&policy).context("serialize effective configuration")?;
        let mut hasher = Sha256::new();
        hasher.update(b"opcore-configuration/v1\0");
        hasher.update(canonical);
        let origins = configuration_origins(&policy, bytes.as_deref(), workflow)?;
        Ok(Self {
            policy,
            state,
            digest: format!("sha256:{}", hex::encode(hasher.finalize())),
            workflow,
            view,
            origins,
            root: root.to_path_buf(),
            bytes,
            capture,
        })
    }

    pub fn is_current(&self) -> Result<bool> {
        if let Some(capture) = &self.capture {
            let repository = GitRepository::discover(&self.root)?;
            return Ok(repository.is_auxiliary_current(capture)?);
        }
        Ok(stable_read(&self.root.join(POLICY_PATH))? == self.bytes)
    }

    pub fn validate_hypothetical(&self, proposed: Option<&[u8]>) -> Result<()> {
        let current = self
            .bytes
            .as_deref()
            .map(parse_policy)
            .transpose()?
            .unwrap_or_default();
        let mut candidate = proposed.map(parse_policy).transpose()?.unwrap_or_default();
        candidate.documentation = current.documentation.clone();
        ensure!(
            candidate == current,
            "hypothetical configuration may change documentation.bindings only; Verify, Sense, targets, providers and workflows must stay unchanged"
        );
        Ok(())
    }

    #[must_use]
    pub fn bind_valid_as_of(&self, source: &str) -> String {
        let source = serde_json::from_str::<Value>(source)
            .unwrap_or_else(|_| Value::String(source.to_owned()));
        serde_json::json!({"kind":"opcore-local", "source":source, "policy":self.digest,
            "configurationView":self.view, "workflow":self.workflow})
        .to_string()
    }
}

fn configuration_origins(
    policy: &Policy,
    bytes: Option<&[u8]>,
    workflow: Option<Workflow>,
) -> Result<BTreeMap<String, String>> {
    let mut origins = BTreeMap::new();
    mark_origins(&serde_json::to_value(policy)?, "", "default", &mut origins);
    if let Some(bytes) = bytes {
        let raw = parse_unique_json(bytes)?;
        mark_origins(&raw, "", "repository", &mut origins);
        if let Some(workflow) = workflow
            && let Some(settings) = raw
                .get("workflows")
                .and_then(|workflows| workflows.get(workflow.as_str()))
        {
            mark_origins(
                settings,
                "",
                &format!("workflow:{}", workflow.as_str()),
                &mut origins,
            );
        }
    }
    origins.retain(|path, _| !path.starts_with("/workflows") && path != "/$schema");
    Ok(origins)
}

fn mark_origins(
    value: &Value,
    pointer: &str,
    origin: &str,
    origins: &mut BTreeMap<String, String>,
) {
    if let Value::Object(fields) = value {
        for (key, value) in fields {
            mark_origins(value, &format!("{pointer}/{key}"), origin, origins);
        }
    } else {
        origins.insert(pointer.to_owned(), origin.to_owned());
    }
}
fn stable_read(path: &Path) -> Result<Option<Vec<u8>>> {
    let mut previous = None;
    for _ in 0..2 {
        let first = read_once(path)?;
        let second = read_once(path)?;
        if first == second {
            return Ok(first);
        }
        previous = Some("policy changed while it was read");
    }
    anyhow::bail!(previous.unwrap_or("policy capture did not stabilize"))
}

fn read_once(path: &Path) -> Result<Option<Vec<u8>>> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("open {POLICY_PATH}")),
    };
    let metadata = file
        .metadata()
        .with_context(|| format!("inspect {POLICY_PATH}"))?;
    ensure!(metadata.is_file(), "{POLICY_PATH} must be a regular file");
    ensure!(
        metadata.len() <= MAX_POLICY_BYTES as u64,
        "{POLICY_PATH} exceeds {MAX_POLICY_BYTES} bytes"
    );
    let capacity = usize::try_from(metadata.len()).context("policy size fits this platform")?;
    let mut bytes = Vec::with_capacity(capacity);
    file.by_ref()
        .take((MAX_POLICY_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read {POLICY_PATH}"))?;
    ensure!(
        bytes.len() <= MAX_POLICY_BYTES,
        "{POLICY_PATH} exceeds {MAX_POLICY_BYTES} bytes"
    );
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests;

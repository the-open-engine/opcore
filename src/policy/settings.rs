use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{documentation::DocumentationBinding, limits::RuleLimits, path::RepoPath};

use super::{SensePolicy, Workflow};

pub const MAX_TARGET_PATHS: usize = 256;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetPolicy {
    pub exclude: Vec<RepoPath>,
}

impl TargetPolicy {
    #[must_use]
    pub fn includes(&self, path: &RepoPath) -> bool {
        !self.exclude.iter().any(|excluded| {
            path == excluded
                || path
                    .as_bytes()
                    .strip_prefix(excluded.as_bytes())
                    .is_some_and(|suffix| suffix.starts_with(b"/"))
        })
    }

    pub(super) fn validate(&self) -> Result<()> {
        ensure!(
            self.exclude.len() <= MAX_TARGET_PATHS,
            "targets.exclude exceeds {MAX_TARGET_PATHS} paths"
        );
        let unique = self.exclude.iter().collect::<BTreeSet<_>>();
        ensure!(
            unique.len() == self.exclude.len(),
            "targets.exclude contains a duplicate path"
        );
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
#[expect(
    clippy::enum_variant_names,
    reason = "variant names match distinct published provider profiles"
)]
pub enum NativeProvider {
    RustNative,
    NodeNative,
    PythonNative,
}

impl NativeProvider {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RustNative => "rust-native",
            Self::NodeNative => "node-native",
            Self::PythonNative => "python-native",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct ProviderOptions {
    pub roots: Vec<String>,
}

impl Default for ProviderOptions {
    fn default() -> Self {
        Self {
            roots: vec![".".into()],
        }
    }
}

impl ProviderOptions {
    fn validate(&self, name: &str) -> Result<()> {
        ensure!(
            self.roots.len() <= MAX_TARGET_PATHS,
            "providers.{name}.roots exceeds {MAX_TARGET_PATHS} paths"
        );
        let mut previous = Vec::<&str>::new();
        for root in &self.roots {
            if root != "." {
                RepoPath::from_protocol(root)
                    .map_err(|error| anyhow::anyhow!("providers.{name}.roots: {error}"))?;
            }
            ensure!(
                !previous.iter().any(|other| roots_overlap(root, other)),
                "providers.{name}.roots must contain distinct non-overlapping project paths"
            );
            previous.push(root);
        }
        Ok(())
    }
}

fn roots_overlap(left: &str, right: &str) -> bool {
    left == "."
        || right == "."
        || left == right
        || left
            .strip_prefix(right)
            .is_some_and(|suffix| suffix.starts_with('/'))
        || right
            .strip_prefix(left)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "kebab-case")]
#[expect(
    clippy::struct_field_names,
    reason = "fields match published provider profile names"
)]
pub struct ProviderSettings {
    pub rust_native: ProviderOptions,
    pub node_native: ProviderOptions,
    pub python_native: ProviderOptions,
    pub external: BTreeMap<String, ExternalProviderSettings>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ExternalProviderSettings {
    pub configuration: Value,
}

impl ProviderSettings {
    pub fn options(&self, provider: NativeProvider) -> &ProviderOptions {
        match provider {
            NativeProvider::RustNative => &self.rust_native,
            NativeProvider::NodeNative => &self.node_native,
            NativeProvider::PythonNative => &self.python_native,
        }
    }

    pub(super) fn validate(&self) -> Result<()> {
        for provider in [
            NativeProvider::RustNative,
            NativeProvider::NodeNative,
            NativeProvider::PythonNative,
        ] {
            self.options(provider).validate(provider.as_str())?;
        }
        ensure!(
            self.external.len() <= 16,
            "providers.external exceeds 16 providers"
        );
        for (id, settings) in &self.external {
            ensure!(
                !id.is_empty()
                    && id.len() <= 64
                    && id.bytes().all(|byte| byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || byte == b'-')
                    && id.as_bytes()[0].is_ascii_lowercase(),
                "providers.external has an invalid provider ID"
            );
            ensure!(
                settings.configuration.is_object(),
                "providers.external.{id}.configuration must be an object"
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct DocumentationSettings {
    pub bindings: Vec<DocumentationBinding>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct CoveragePolicy {
    pub allow_partial: bool,
    pub allow_node_builtins: bool,
}

macro_rules! override_fields {
    ($(#[$meta:meta])* $name:ident, $target:ty, {$($field:ident : $type:ty),+ $(,)?}) => {
        $(#[$meta])*
        #[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
        #[serde(default, deny_unknown_fields, rename_all = "camelCase")]
        pub struct $name { $(#[serde(skip_serializing_if = "Option::is_none")] pub $field: Option<$type>,)+ }
        impl $name {
            pub(super) fn apply(&self, target: &mut $target) {
                $(if let Some(value) = &self.$field { target.$field.clone_from(value); })+
            }
        }
    };
}

override_fields!(#[expect(clippy::struct_field_names, reason = "threshold fields match the shared RuleLimits schema")] VerifyOverride, RuleLimits, {
    max_file_lines: u32, max_line_bytes: u32, max_function_lines: u32,
    max_parameters: u32, max_nesting: u32, max_cyclomatic_complexity: u32,
});
override_fields!(SenseOverride, SensePolicy, {
    important_fan_in: usize, minimum_identical_bytes: usize,
    max_dependency_targets: usize, max_edge_selectors: usize,
    max_module_exports: usize, max_shape_members: usize,
});
override_fields!(CoverageOverride, CoveragePolicy, {
    allow_partial: bool, allow_node_builtins: bool,
});
override_fields!(ProviderOverride, ProviderOptions, { roots: Vec<String> });
override_fields!(TargetOverride, TargetPolicy, { exclude: Vec<RepoPath> });

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "kebab-case")]
#[expect(
    clippy::struct_field_names,
    reason = "overrides use the same published provider profile names"
)]
pub struct ProvidersOverride {
    pub rust_native: ProviderOverride,
    pub node_native: ProviderOverride,
    pub python_native: ProviderOverride,
}

impl ProvidersOverride {
    pub(super) fn apply(&self, target: &mut ProviderSettings) {
        self.rust_native.apply(&mut target.rust_native);
        self.node_native.apply(&mut target.node_native);
        self.python_native.apply(&mut target.python_native);
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkflowOverride {
    pub verify: VerifyOverride,
    pub sense: SenseOverride,
    pub targets: TargetOverride,
    pub providers: ProvidersOverride,
    pub coverage: CoverageOverride,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native: Option<Vec<NativeProvider>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "kebab-case")]
pub struct Workflows {
    pub post_edit: WorkflowOverride,
    pub pre_commit: WorkflowOverride,
    pub ci: WorkflowOverride,
}

impl Workflows {
    pub(super) fn is_empty(&self) -> bool {
        self == &Self::default()
    }
    pub(super) const fn selected(&self, workflow: Workflow) -> &WorkflowOverride {
        match workflow {
            Workflow::PostEdit => &self.post_edit,
            Workflow::PreCommit => &self.pre_commit,
            Workflow::Ci => &self.ci,
        }
    }
}

//! Provider-specific request settings and their stable assessment identity.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{limits::RuleLimits, policy::validate_verify};

use super::{ProviderProfile, RpcFailure, digest_json};

#[derive(Clone, Debug)]
pub(super) struct Configuration {
    pub(super) verify: RuleLimits,
    pub(super) digest: String,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct FastConfiguration {
    verify: RuleLimits,
}

pub(super) fn resolve(
    value: Option<&Value>,
    profile: ProviderProfile,
) -> Result<Configuration, RpcFailure> {
    let empty = json!({});
    let value = value.unwrap_or(&empty);
    let object = value
        .as_object()
        .ok_or_else(|| RpcFailure::input("configuration must be an object"))?;
    let verify = if profile == ProviderProfile::Fast {
        let settings: FastConfiguration = serde_json::from_value(value.clone())
            .map_err(|error| RpcFailure::input(format!("invalid configuration: {error}")))?;
        validate_verify(&settings.verify)
            .map_err(|error| RpcFailure::input(format!("invalid configuration: {error:#}")))?;
        settings.verify
    } else {
        if !object.is_empty() {
            return Err(RpcFailure::input(format!(
                concat!(
                    "{} accepts only an empty configuration object; ",
                    "native project settings come from captured workspace inputs"
                ),
                profile.provider_id()
            )));
        }
        RuleLimits::default()
    };
    let settings = if profile == ProviderProfile::Fast {
        json!({ "verify": verify })
    } else {
        empty
    };
    let digest = digest_json(&json!({
        "provider": profile.provider_id(),
        "capabilityVersion": super::CAPABILITY_VERSION,
        "configuration": settings
    }))?;
    Ok(Configuration { verify, digest })
}

/// Computes the identity a bundled provider must report for requested settings.
pub(crate) fn expected_digest(
    value: Option<&Value>,
    profile: ProviderProfile,
) -> Result<String, RpcFailure> {
    resolve(value, profile).map(|configuration| configuration.digest)
}

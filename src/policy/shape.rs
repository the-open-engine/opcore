//! Precise field errors using the configuration's typed default field shapes.

use anyhow::{Result, ensure};
use serde_json::{Value, json};

use super::{POLICY_PATH, Policy};

pub(super) fn validate(value: &Value) -> Result<()> {
    let mut defaults = serde_json::to_value(Policy::default())?;
    defaults["$schema"] = json!("");
    defaults["targets"]["exclude"] = json!(["path"]);
    defaults["native"] = json!(["rust-native"]);
    defaults["documentation"]["bindings"] = json!([{"source":"path","document":"path"}]);
    let mut workflow = defaults.clone();
    if let Some(fields) = workflow.as_object_mut() {
        for key in ["$schema", "schemaVersion", "documentation"] {
            fields.remove(key);
        }
    }
    defaults["workflows"] = json!({"post-edit":workflow,"pre-commit":workflow,"ci":workflow});
    validate_value(value, &defaults, "")
}

fn validate_value(value: &Value, expected: &Value, pointer: &str) -> Result<()> {
    match expected {
        Value::Object(fields) => validate_object(value, fields, pointer),
        Value::Array(items) => validate_array(value, items.first(), pointer),
        Value::Number(_) => {
            require_type(value.as_u64().is_some(), pointer, "a non-negative integer")
        }
        Value::Bool(_) => require_type(value.is_boolean(), pointer, "true or false"),
        Value::String(_) => validate_string(value, pointer),
        Value::Null => Ok(()),
    }
}

fn validate_object(
    value: &Value,
    expected: &serde_json::Map<String, Value>,
    pointer: &str,
) -> Result<()> {
    let fields = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("{POLICY_PATH}{pointer}: expected an object"))?;
    for (name, value) in fields {
        let path = format!("{pointer}/{name}");
        let shape = expected.get(name).ok_or_else(|| {
            anyhow::anyhow!(
                "{POLICY_PATH}{path}: unknown field; expected {}",
                expected.keys().cloned().collect::<Vec<_>>().join(", ")
            )
        })?;
        validate_value(value, shape, &path)?;
    }
    Ok(())
}

fn validate_array(value: &Value, item: Option<&Value>, pointer: &str) -> Result<()> {
    let values = value.as_array().ok_or_else(|| {
        anyhow::anyhow!("{POLICY_PATH}{pointer}: expected an array; use [] to clear it")
    })?;
    if let Some(item) = item {
        for (index, value) in values.iter().enumerate() {
            validate_value(value, item, &format!("{pointer}/{index}"))?;
        }
    }
    Ok(())
}

fn require_type(valid: bool, pointer: &str, expected: &str) -> Result<()> {
    ensure!(
        valid,
        "{POLICY_PATH}{pointer}: expected {expected}; omit the field to inherit"
    );
    Ok(())
}

fn validate_string(value: &Value, pointer: &str) -> Result<()> {
    require_type(value.is_string(), pointer, "a string")?;
    let Some(text) = value.as_str() else {
        return Ok(());
    };
    let root = pointer.contains("/providers/") && pointer.contains("/roots/");
    if is_literal_path(pointer) || (root && text != ".") {
        crate::path::RepoPath::from_protocol(text).map_err(|error| {
            anyhow::anyhow!(
                "{POLICY_PATH}{pointer}: {error}; use a literal repository-relative path"
            )
        })?;
    }
    if pointer.contains("/native/") {
        serde_json::from_value::<super::NativeProvider>(value.clone())
            .map_err(|error| anyhow::anyhow!("{POLICY_PATH}{pointer}: {error}"))?;
    }
    Ok(())
}

fn is_literal_path(pointer: &str) -> bool {
    pointer.contains("/targets/exclude/")
        || (pointer.starts_with("/documentation/bindings/")
            && (pointer.ends_with("/source") || pointer.ends_with("/document")))
}

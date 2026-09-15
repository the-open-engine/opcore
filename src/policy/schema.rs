//! Editor schema derived from the same typed defaults used by configuration resolution.

use serde_json::{Value, json};

use super::{Policy, settings::MAX_TARGET_PATHS};

pub fn schema() -> Value {
    let defaults = serde_json::to_value(Policy::default()).unwrap_or(Value::Null);
    let mut properties = serde_json::Map::new();
    properties.insert("$schema".into(), json!({"type":"string"}));
    properties.insert("schemaVersion".into(), json!({"const":1,"default":1}));
    for name in ["verify", "sense", "coverage"] {
        properties.insert(name.into(), scalar_section(&defaults[name]));
    }
    properties.insert(
        "targets".into(),
        object(json!({"exclude":path_list(false)})),
    );
    let provider = object(json!({"roots":path_list(true)}));
    let providers =
        object(json!({"rust-native":provider,"node-native":provider,"python-native":provider}));
    properties.insert("providers".into(), providers);
    properties.insert(
        "native".into(),
        json!({"type":"array","uniqueItems":true,"maxItems":3,
        "default":[],"items":{"enum":["rust-native","node-native","python-native"]}}),
    );
    properties.insert("documentation".into(), object(json!({"bindings": {
        "type":"array", "maxItems":crate::documentation::MAX_DOCUMENTATION_BINDINGS,"default":[],
        "items": {"type":"object", "additionalProperties":false,
            "required":["source","document"], "properties":{"source":path(),"document":path()}}
    }})));
    let mut workflow = object(
        properties
            .iter()
            .filter(|(key, _)| {
                matches!(
                    key.as_str(),
                    "verify" | "sense" | "coverage" | "targets" | "providers" | "native"
                )
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<serde_json::Map<_, _>>()
            .into(),
    );
    remove_override_defaults(&mut workflow);
    let mut post_edit = workflow.clone();
    post_edit["properties"]["native"]["maxItems"] = json!(0);
    properties.insert(
        "workflows".into(),
        object(json!({"post-edit":post_edit,"pre-commit":workflow,"ci":workflow})),
    );
    json!({"$schema":"https://json-schema.org/draft/2020-12/schema",
        "title":"Opcore repository configuration", "type":"object",
        "additionalProperties":false,"required":["schemaVersion"],"properties":properties})
}

fn remove_override_defaults(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.remove("default");
            for field in fields.values_mut() {
                remove_override_defaults(field);
            }
        }
        Value::Array(values) => {
            for value in values {
                remove_override_defaults(value);
            }
        }
        _ => {}
    }
}

fn object(properties: Value) -> Value {
    let mut object = json!({"type":"object","additionalProperties":false});
    object["properties"] = properties;
    object
}

fn scalar_section(defaults: &Value) -> Value {
    let properties = defaults
        .as_object()
        .into_iter()
        .flatten()
        .map(|(name, default)| {
            let mut property = if default.is_boolean() {
                json!({"type":"boolean"})
            } else {
                json!({"type":"integer","minimum":0})
            };
            if let Some((minimum, maximum)) = numeric_bounds(name) {
                property["minimum"] = json!(minimum);
                property["maximum"] = json!(maximum);
            }
            property["default"] = default.clone();
            (name.clone(), property)
        })
        .collect::<serde_json::Map<_, _>>();
    object(properties.into())
}

fn numeric_bounds(name: &str) -> Option<(usize, usize)> {
    use crate::limits;
    Some(match name {
        "maxFileLines" | "maxFunctionLines" | "maxCyclomaticComplexity" => {
            (0, limits::MAX_SOURCE_BYTES)
        }
        "maxLineBytes" => (0, limits::MAX_LINE_BYTES),
        "maxParameters" => (0, limits::MAX_DEPENDENCY_FACTS_PER_FILE),
        "maxNesting" => (0, limits::MAX_STRUCTURAL_DEPTH),
        "importantFanIn" => (1, limits::MAX_FILES),
        "minimumIdenticalBytes" => (1, limits::MAX_SOURCE_BYTES),
        "maxDependencyTargets" => (0, limits::MAX_GRAPH_EDGES),
        "maxEdgeSelectors" | "maxModuleExports" | "maxShapeMembers" => {
            (0, limits::MAX_INTERFACE_FACTS_PER_FILE)
        }
        _ => return None,
    })
}

fn path() -> Value {
    json!({"type":"string","minLength":1,"maxLength":crate::path::MAX_REPOSITORY_PATH_BYTES,
        "description":"Literal repository-relative file or subtree path; no glob syntax or dot/parent components.",
        "pattern":"^(?![A-Za-z]:)(?!/)(?!.*\\\\)(?!.*(?:^|/)(?:\\.|\\.\\.)(?:/|$))(?!.*//)(?!.*\\u0000)[^/]+(?:/[^/]+)*$"})
}

fn path_list(root: bool) -> Value {
    let item = if root {
        json!({"anyOf":[{"const":"."},path()]})
    } else {
        path()
    };
    json!({"type":"array","uniqueItems":true,"maxItems":MAX_TARGET_PATHS,"items":item,
        "default":if root { json!(["."]) } else { json!([]) }})
}

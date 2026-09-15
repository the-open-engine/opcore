//! Strict, bounded ownership declarations for source documentation.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{json::parse_unique_json, path::RepoPath};

pub const DOCUMENTATION_REGISTRY_PATH: &str = crate::policy::POLICY_PATH;
pub const DOCUMENTATION_REGISTRY_SCHEMA_VERSION: u32 = 1;
pub const MAX_DOCUMENTATION_REGISTRY_BYTES: usize = 256 * 1024;
pub const MAX_DOCUMENTATION_BINDINGS: usize = 4_096;

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DocumentationBinding {
    pub source: RepoPath,
    pub document: RepoPath,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentationRegistry {
    pub schema_version: u32,
    pub bindings: Vec<DocumentationBinding>,
}

impl DocumentationRegistry {
    #[must_use]
    pub fn document_for(&self, source: &RepoPath) -> Option<&RepoPath> {
        self.bindings
            .binary_search_by(|binding| binding.source.cmp(source))
            .ok()
            .map(|index| &self.bindings[index].document)
    }
}

#[derive(Debug, Eq, Error, PartialEq)]
pub enum DocumentationRegistryError {
    #[error("documentation registry exceeds {MAX_DOCUMENTATION_REGISTRY_BYTES} bytes")]
    TooLarge,
    #[error("documentation registry is malformed: {0}")]
    Malformed(String),
    #[error("documentation registry has more than {MAX_DOCUMENTATION_BINDINGS} bindings")]
    TooManyBindings,
    #[error("documentation registry contains duplicate source path {0}")]
    DuplicateSource(RepoPath),
    #[error("documentation binding source and document must differ: {0}")]
    SelfBinding(RepoPath),
    #[error("documentation binding cannot use the registry as its document")]
    RegistryAsDocument,
}

pub fn parse_optional_documentation_registry(
    bytes: Option<&[u8]>,
) -> Result<Option<DocumentationRegistry>, DocumentationRegistryError> {
    let Some(bytes) = bytes else {
        return Ok(None);
    };
    if bytes.len() > MAX_DOCUMENTATION_REGISTRY_BYTES {
        return Err(DocumentationRegistryError::TooLarge);
    }
    let value = parse_unique_json(bytes)
        .map_err(|error| DocumentationRegistryError::Malformed(error.to_string()))?;
    if value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(u64::from(DOCUMENTATION_REGISTRY_SCHEMA_VERSION))
    {
        return Err(DocumentationRegistryError::Malformed(format!(
            "schemaVersion must be {DOCUMENTATION_REGISTRY_SCHEMA_VERSION}"
        )));
    }
    let Some(documentation) = value.get("documentation") else {
        return Ok(None);
    };
    let mut settings: crate::policy::DocumentationSettings =
        serde_json::from_value(documentation.clone()).map_err(|error| {
            DocumentationRegistryError::Malformed(format!("documentation: {error}"))
        })?;
    validate_bindings(&settings.bindings)?;
    settings.bindings.sort();
    Ok(Some(DocumentationRegistry {
        schema_version: DOCUMENTATION_REGISTRY_SCHEMA_VERSION,
        bindings: settings.bindings,
    }))
}

#[cfg(test)]
pub fn parse_documentation_registry(
    bytes: &[u8],
) -> Result<DocumentationRegistry, DocumentationRegistryError> {
    Ok(
        parse_optional_documentation_registry(Some(bytes))?.unwrap_or(DocumentationRegistry {
            schema_version: DOCUMENTATION_REGISTRY_SCHEMA_VERSION,
            bindings: Vec::new(),
        }),
    )
}

pub fn validate_bindings(
    bindings: &[DocumentationBinding],
) -> Result<(), DocumentationRegistryError> {
    if bindings.len() > MAX_DOCUMENTATION_BINDINGS {
        return Err(DocumentationRegistryError::TooManyBindings);
    }
    let mut seen = BTreeSet::new();
    for binding in bindings {
        if !seen.insert(&binding.source) {
            return Err(DocumentationRegistryError::DuplicateSource(
                binding.source.clone(),
            ));
        }
        if binding.source == binding.document {
            return Err(DocumentationRegistryError::SelfBinding(
                binding.source.clone(),
            ));
        }
        if binding.document.as_utf8() == Some(DOCUMENTATION_REGISTRY_PATH) {
            return Err(DocumentationRegistryError::RegistryAsDocument);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(bindings: &str) -> Vec<u8> {
        format!(r#"{{"schemaVersion":1,"documentation":{{"bindings":[{bindings}]}}}}"#).into_bytes()
    }

    #[test]
    fn absent_registry_is_distinct_from_an_empty_registry() {
        assert_eq!(parse_optional_documentation_registry(None).unwrap(), None);
        assert_eq!(
            parse_optional_documentation_registry(Some(&registry("")))
                .unwrap()
                .unwrap()
                .bindings,
            Vec::new()
        );
    }

    #[test]
    fn parses_exact_bindings_in_deterministic_source_order() {
        let parsed = parse_documentation_registry(&registry(
            r#"{"source":"src/z.ts","document":"docs/z.md"},{"source":"src/a.ts","document":"docs/a.md"}"#,
        ))
        .unwrap();
        assert_eq!(parsed.schema_version, 1);
        assert_eq!(parsed.bindings[0].source.as_utf8(), Some("src/a.ts"));
        assert_eq!(
            parsed
                .document_for(&RepoPath::from_protocol("src/z.ts").unwrap())
                .and_then(RepoPath::as_utf8),
            Some("docs/z.md")
        );
    }

    #[test]
    fn rejects_duplicate_keys_unknown_fields_and_duplicate_sources() {
        for malformed in [
            br#"{"schemaVersion":1,"schemaVersion":1,"bindings":[]}"#.as_slice(),
            br#"{"schemaVersion":1,"documentation":{"bindings":[],"unknown":true}}"#.as_slice(),
            br#"{"schemaVersion":1,"documentation":{"bindings":[{
                "source":"src/a.ts","document":"docs/a.md","unknown":true
            }]}}"#
                .as_slice(),
        ] {
            assert!(matches!(
                parse_documentation_registry(malformed),
                Err(DocumentationRegistryError::Malformed(_))
            ));
        }
        let duplicate = registry(
            r#"{"source":"src/a.ts","document":"docs/a.md"},{"source":"src/a.ts","document":"docs/other.md"}"#,
        );
        assert!(matches!(
            parse_documentation_registry(&duplicate),
            Err(DocumentationRegistryError::DuplicateSource(_))
        ));
    }

    #[test]
    fn rejects_self_binding_and_registry_as_document() {
        assert!(matches!(
            parse_documentation_registry(&registry(
                r#"{"source":"src/a.ts","document":"src/a.ts"}"#
            )),
            Err(DocumentationRegistryError::SelfBinding(_))
        ));
        assert!(
            parse_documentation_registry(&registry(
                r#"{"source":"src/a.ts","document":".opcore.json"}"#
            ))
            .is_err()
        );
    }

    #[test]
    fn rejects_malformed_versions_paths_and_json() {
        assert!(parse_documentation_registry(br#"{"schemaVersion":2}"#).is_err());
        for invalid in ["../src/a.ts", "/src/a.ts", "src//a.ts", "src\\a.ts"] {
            let bytes = registry(&format!(
                r#"{{"source":{},"document":"docs/a.md"}}"#,
                serde_json::to_string(invalid).unwrap()
            ));
            assert!(matches!(
                parse_documentation_registry(&bytes),
                Err(DocumentationRegistryError::Malformed(_))
            ));
        }
        assert!(matches!(
            parse_documentation_registry(b"{"),
            Err(DocumentationRegistryError::Malformed(_))
        ));
    }

    #[test]
    fn treats_pattern_metacharacters_as_literal_git_path_bytes() {
        let parsed = parse_documentation_registry(&registry(
            r#"{"source":"src/[literal]*?.ts","document":"docs/[literal]*?.md"}"#,
        ))
        .unwrap();
        assert_eq!(
            parsed.bindings[0].source.as_utf8(),
            Some("src/[literal]*?.ts")
        );
    }

    #[test]
    fn enforces_byte_and_binding_caps() {
        assert_eq!(
            parse_documentation_registry(&vec![b' '; MAX_DOCUMENTATION_REGISTRY_BYTES + 1]),
            Err(DocumentationRegistryError::TooLarge)
        );
        let bindings = (0..=MAX_DOCUMENTATION_BINDINGS)
            .map(|index| format!(r#"{{"source":"s/{index}","document":"d/{index}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        assert!(parse_documentation_registry(&registry(&bindings)).is_err());
    }
}

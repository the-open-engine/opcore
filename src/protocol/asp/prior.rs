//! Validation-only representations for canonical prior check evidence.

use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::Value;

use super::{Baseline, RpcFailure, optional_non_null, validate_blob_ref};

const DIAGNOSTIC_DATA_FORBIDDEN: &[&str] = &[
    "authority",
    "assurance",
    "apply",
    "decision",
    "disposition",
    "fail",
    "pass",
    "transactionGuarantee",
    "verdict",
    "applyReceipt",
    "receipt",
    "policyDigest",
    "policyRef",
    "policyReference",
    "authorityEvidence",
    "hostDecision",
    "applyAttempt",
    "applyResult",
];
const EDIT_DATA_FORBIDDEN: &[&str] = &[
    "authority",
    "assurance",
    "apply",
    "command",
    "commands",
    "decision",
    "disposition",
    "fail",
    "pass",
    "script",
    "transactionGuarantee",
    "verdict",
    "applyReceipt",
    "receipt",
    "policyDigest",
    "policyRef",
    "policyReference",
    "authorityEvidence",
    "hostDecision",
    "applyAttempt",
    "applyResult",
];
const MAX_STRUCTURED_DATA_DEPTH: usize = 64;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct PriorDiagnostic {
    diagnostic: Diagnostic,
    valid_as_of: ValidAsOf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct PriorAssessment {
    assessment_id: String,
    valid_as_of: ValidAsOf,
    provider: Provider,
    #[serde(default, deserialize_with = "optional_non_null")]
    digest: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ValidAsOf {
    baseline: Baseline,
    changeset_digest: String,
    blobs: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Provider {
    id: String,
    version: String,
    config_digest: String,
    capability_version: String,
    #[serde(default, deserialize_with = "optional_non_null")]
    build_digest: Option<String>,
    #[serde(default, deserialize_with = "optional_non_null")]
    artifact_digest: Option<String>,
    #[serde(default, deserialize_with = "optional_non_null")]
    capability_family: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Diagnostic {
    code: String,
    severity: DiagnosticSeverity,
    source: String,
    message: String,
    location: Location,
    fingerprint: String,
    #[serde(default, deserialize_with = "optional_non_null")]
    introduced: Option<bool>,
    #[serde(default, deserialize_with = "optional_non_null")]
    help: Option<String>,
    #[serde(default, deserialize_with = "optional_non_null")]
    code_description: Option<CodeDescription>,
    #[serde(default, deserialize_with = "optional_non_null")]
    fix: Option<Fix>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Location {
    path: String,
    #[serde(default, deserialize_with = "optional_non_null")]
    range: Option<Range>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Range {
    start: Position,
    end: Position,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Position {
    line: u64,
    char: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CodeDescription {
    #[serde(default, deserialize_with = "optional_non_null")]
    href: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Fix {
    Reference(ReferenceFix),
    Workspace(WorkspaceFix),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReferenceFix {
    #[serde(default, deserialize_with = "optional_non_null")]
    edit_ref: Option<String>,
    #[serde(default, deserialize_with = "optional_non_null")]
    act_ref: Option<String>,
    #[serde(default, deserialize_with = "optional_non_null")]
    args: Option<serde_json::Map<String, Value>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WorkspaceFix {
    workspace_edit: WorkspaceEdit,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WorkspaceEdit {
    baseline: Baseline,
    document_changes: Vec<DocumentChange>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DocumentChange {
    path: String,
    kind: DocumentChangeKind,
    precondition: Precondition,
    #[serde(default, deserialize_with = "optional_non_null")]
    to: Option<String>,
    #[serde(default, deserialize_with = "optional_non_null")]
    after: Option<String>,
    #[serde(default, deserialize_with = "optional_non_null")]
    edits: Option<Vec<TextEdit>>,
    #[serde(default, deserialize_with = "optional_non_null")]
    annotations: Option<Vec<Annotation>>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum DocumentChangeKind {
    Create,
    Modify,
    Delete,
    Rename,
    Move,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Precondition {
    #[serde(default, deserialize_with = "optional_non_null")]
    expected_digest: Option<String>,
    #[serde(default, deserialize_with = "optional_non_null")]
    expected_absence: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TextEdit {
    range: Range,
    range_basis: String,
    coordinate_system: String,
    new_text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Annotation {
    message: String,
    #[serde(default, deserialize_with = "optional_non_null")]
    range: Option<Range>,
    #[serde(default, deserialize_with = "optional_non_null")]
    data: Option<serde_json::Map<String, Value>>,
}

pub(super) fn validate(
    diagnostics: &[PriorDiagnostic],
    assessments: &[PriorAssessment],
) -> Result<(), RpcFailure> {
    for diagnostic in diagnostics {
        diagnostic.validate()?;
    }
    for assessment in assessments {
        assessment.validate()?;
    }
    Ok(())
}

impl PriorDiagnostic {
    fn validate(&self) -> Result<(), RpcFailure> {
        self.valid_as_of.validate()?;
        self.diagnostic.validate()
    }
}

impl PriorAssessment {
    fn validate(&self) -> Result<(), RpcFailure> {
        let _ = (&self.assessment_id, &self.digest);
        self.valid_as_of.validate()?;
        self.provider.validate()
    }
}

impl ValidAsOf {
    fn validate(&self) -> Result<(), RpcFailure> {
        self.baseline.validate_timestamp()?;
        let _ = &self.changeset_digest;
        let mut unique = BTreeSet::new();
        for blob in &self.blobs {
            validate_blob_ref(blob)?;
            if !unique.insert(blob) {
                return Err(RpcFailure::input("prior validAsOf blobs must be unique"));
            }
        }
        Ok(())
    }
}

impl Provider {
    fn validate(&self) -> Result<(), RpcFailure> {
        if [
            &self.id,
            &self.version,
            &self.config_digest,
            &self.capability_version,
        ]
        .into_iter()
        .any(String::is_empty)
        {
            return Err(RpcFailure::input(
                "prior assessment provider fields must not be empty",
            ));
        }
        if self
            .capability_family
            .as_deref()
            .is_some_and(|family| family != "check")
        {
            return Err(RpcFailure::input(
                "prior assessment capabilityFamily must be check",
            ));
        }
        let _ = (&self.build_digest, &self.artifact_digest);
        Ok(())
    }
}

impl Diagnostic {
    fn validate(&self) -> Result<(), RpcFailure> {
        let _ = (
            &self.code,
            &self.severity,
            &self.source,
            &self.message,
            &self.fingerprint,
            &self.introduced,
            &self.help,
        );
        if let Some(description) = &self.code_description {
            let _ = &description.href;
        }
        self.location.validate();
        if let Some(fix) = &self.fix {
            fix.validate()?;
        }
        Ok(())
    }
}

impl Location {
    fn validate(&self) {
        let _ = (&self.path, self.range.as_ref().map(Range::touch));
    }
}

impl Range {
    fn touch(&self) {
        let _ = (
            self.start.line,
            self.start.char,
            self.end.line,
            self.end.char,
        );
    }
}

impl Fix {
    fn validate(&self) -> Result<(), RpcFailure> {
        match self {
            Self::Reference(fix) => fix.validate(),
            Self::Workspace(fix) => fix.workspace_edit.validate(),
        }
    }
}

impl ReferenceFix {
    fn validate(&self) -> Result<(), RpcFailure> {
        if self.edit_ref.is_some() == self.act_ref.is_some() {
            return Err(RpcFailure::input(
                "prior diagnostic fix must select exactly one reference kind",
            ));
        }
        validate_data_object(self.args.as_ref(), DIAGNOSTIC_DATA_FORBIDDEN)
    }
}

impl WorkspaceEdit {
    fn validate(&self) -> Result<(), RpcFailure> {
        self.baseline.validate_timestamp()?;
        for change in &self.document_changes {
            change.validate()?;
        }
        Ok(())
    }
}

impl DocumentChange {
    fn validate(&self) -> Result<(), RpcFailure> {
        let _ = &self.path;
        self.precondition.validate()?;
        self.validate_content()?;
        if !self.has_valid_shape() {
            return Err(RpcFailure::input(
                "prior diagnostic workspaceEdit has an invalid document change shape",
            ));
        }
        Ok(())
    }

    fn validate_content(&self) -> Result<(), RpcFailure> {
        if let Some(after) = &self.after {
            validate_blob_ref(after)?;
        }
        if let Some(edits) = &self.edits {
            edits.iter().try_for_each(TextEdit::validate)?;
        }
        if let Some(annotations) = &self.annotations {
            annotations.iter().try_for_each(Annotation::validate)?;
        }
        Ok(())
    }

    fn has_valid_shape(&self) -> bool {
        let expected_digest = self.precondition.expected_digest.is_some();
        match self.kind {
            DocumentChangeKind::Create => self.valid_create_shape(),
            DocumentChangeKind::Modify => self.valid_modify_shape(expected_digest),
            DocumentChangeKind::Delete => expected_digest,
            DocumentChangeKind::Rename | DocumentChangeKind::Move => {
                expected_digest && self.to.is_some()
            }
        }
    }

    fn valid_create_shape(&self) -> bool {
        self.after.is_some() && self.precondition.expected_absence == Some(true)
    }

    fn valid_modify_shape(&self, expected_digest: bool) -> bool {
        expected_digest && (self.edits.is_some() ^ self.after.is_some())
    }
}

impl Precondition {
    fn validate(&self) -> Result<(), RpcFailure> {
        if let Some(digest) = &self.expected_digest {
            validate_blob_ref(digest)?;
        }
        if self.expected_absence.is_some_and(|value| !value)
            || (self.expected_digest.is_some() == self.expected_absence.is_some())
        {
            return Err(RpcFailure::input(
                "prior workspaceEdit precondition must select exactly one valid condition",
            ));
        }
        Ok(())
    }
}

impl TextEdit {
    fn validate(&self) -> Result<(), RpcFailure> {
        self.range.touch();
        validate_blob_ref(&self.range_basis)?;
        if self.coordinate_system != "utf16" {
            return Err(RpcFailure::input(
                "prior workspaceEdit coordinateSystem must be utf16",
            ));
        }
        let _ = &self.new_text;
        Ok(())
    }
}

impl Annotation {
    fn validate(&self) -> Result<(), RpcFailure> {
        let _ = (&self.message, self.range.as_ref().map(Range::touch));
        validate_data_object(self.data.as_ref(), EDIT_DATA_FORBIDDEN)
    }
}

fn validate_data_object(
    object: Option<&serde_json::Map<String, Value>>,
    forbidden: &[&str],
) -> Result<(), RpcFailure> {
    if let Some(object) = object {
        validate_data(object, forbidden, 0)?;
    }
    Ok(())
}

fn validate_data(
    object: &serde_json::Map<String, Value>,
    forbidden: &[&str],
    depth: usize,
) -> Result<(), RpcFailure> {
    if depth >= MAX_STRUCTURED_DATA_DEPTH {
        return Err(RpcFailure::input(
            "prior diagnostic structured data exceeds its nesting bound",
        ));
    }
    for (key, value) in object {
        if forbidden.contains(&key.as_str()) {
            return Err(RpcFailure::input(format!(
                "prior diagnostic structured data contains forbidden field {key}"
            )));
        }
        validate_data_value(value, forbidden, depth + 1)?;
    }
    Ok(())
}

fn validate_data_value(value: &Value, forbidden: &[&str], depth: usize) -> Result<(), RpcFailure> {
    if depth >= MAX_STRUCTURED_DATA_DEPTH {
        return Err(RpcFailure::input(
            "prior diagnostic structured data exceeds its nesting bound",
        ));
    }
    match value {
        Value::Array(values) => {
            for value in values {
                validate_data_value(value, forbidden, depth + 1)?;
            }
        }
        Value::Object(object) => {
            validate_data(object, forbidden, depth)?;
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    const BLOB: &str =
        "blob:sha256:0000000000000000000000000000000000000000000000000000000000000000";

    fn valid_as_of() -> Value {
        json!({
            "baseline": { "rev": "git:tree:test" },
            "changesetDigest": "sha256:changeset",
            "blobs": [BLOB]
        })
    }

    fn diagnostic(fix: &Value) -> PriorDiagnostic {
        serde_json::from_value(json!({
            "diagnostic": {
                "code": "example/rule",
                "severity": "error",
                "source": "example",
                "message": "message",
                "location": {
                    "path": "src/lib.rs",
                    "range": {
                        "start": { "line": 0, "char": 1 },
                        "end": { "line": 0, "char": 2 }
                    }
                },
                "fingerprint": "fingerprint",
                "introduced": true,
                "help": "help",
                "codeDescription": { "href": "https://example.invalid/rule" },
                "fix": fix
            },
            "validAsOf": valid_as_of()
        }))
        .expect("prior diagnostic")
    }

    #[test]
    fn validates_reference_and_workspace_prior_evidence() {
        let reference = diagnostic(&json!({
            "editRef": "provider-fix",
            "args": { "nested": [{ "safe": true }] }
        }));
        reference.validate().expect("valid reference fix");

        let workspace = diagnostic(&json!({
            "workspaceEdit": {
                "baseline": { "rev": "git:tree:test" },
                "documentChanges": [{
                    "path": "created.rs",
                    "kind": "create",
                    "precondition": { "expectedAbsence": true },
                    "after": BLOB
                }, {
                    "path": "modified.rs",
                    "kind": "modify",
                    "precondition": { "expectedDigest": BLOB },
                    "edits": [{
                        "range": {
                            "start": { "line": 0, "char": 0 },
                            "end": { "line": 0, "char": 1 }
                        },
                        "rangeBasis": BLOB,
                        "coordinateSystem": "utf16",
                        "newText": "replacement"
                    }],
                    "annotations": [{
                        "message": "annotation",
                        "data": { "nested": [1, null, false] }
                    }]
                }, {
                    "path": "deleted.rs",
                    "kind": "delete",
                    "precondition": { "expectedDigest": BLOB }
                }, {
                    "path": "old.rs",
                    "kind": "rename",
                    "precondition": { "expectedDigest": BLOB },
                    "to": "new.rs"
                }, {
                    "path": "from.rs",
                    "kind": "move",
                    "precondition": { "expectedDigest": BLOB },
                    "to": "to.rs"
                }]
            }
        }));
        workspace.validate().expect("valid workspace fix");

        let assessment: PriorAssessment = serde_json::from_value(json!({
            "assessmentId": "assessment",
            "validAsOf": valid_as_of(),
            "provider": {
                "id": "provider",
                "version": "1",
                "configDigest": "sha256:config",
                "capabilityVersion": "check/1.0",
                "buildDigest": "sha256:build",
                "artifactDigest": "sha256:artifact",
                "capabilityFamily": "check"
            },
            "digest": "sha256:assessment"
        }))
        .expect("prior assessment");
        validate(&[reference, workspace], &[assessment]).expect("valid prior evidence");
    }

    #[test]
    fn rejects_duplicate_blobs_provider_misattribution_and_unsafe_fixes() {
        let mut duplicate = valid_as_of();
        duplicate["blobs"] = json!([BLOB, BLOB]);
        let duplicate: ValidAsOf = serde_json::from_value(duplicate).expect("valid shape");
        assert!(duplicate.validate().is_err());

        let provider = Provider {
            id: String::new(),
            version: "1".into(),
            config_digest: "digest".into(),
            capability_version: "check/1.0".into(),
            build_digest: None,
            artifact_digest: None,
            capability_family: Some("edit".into()),
        };
        assert!(provider.validate().is_err());

        let both = diagnostic(&json!({ "editRef": "edit", "actRef": "act" }));
        assert!(both.validate().is_err());

        let forbidden = diagnostic(&json!({
            "editRef": "edit",
            "args": { "nested": [{ "hostDecision": "allow" }] }
        }));
        assert!(forbidden.validate().is_err());
    }

    #[test]
    fn rejects_deep_data_and_invalid_workspace_edit_shapes() {
        let mut nested = json!({});
        for _ in 0..MAX_STRUCTURED_DATA_DEPTH {
            nested = json!({ "next": nested });
        }
        assert!(
            diagnostic(&json!({ "editRef": "edit", "args": nested }))
                .validate()
                .is_err()
        );

        let invalid = diagnostic(&json!({
            "workspaceEdit": {
                "baseline": { "rev": "git:tree:test" },
                "documentChanges": [{
                    "path": "file.rs",
                    "kind": "modify",
                    "precondition": { "expectedAbsence": false },
                    "edits": [{
                        "range": {
                            "start": { "line": 0, "char": 0 },
                            "end": { "line": 0, "char": 0 }
                        },
                        "rangeBasis": BLOB,
                        "coordinateSystem": "bytes",
                        "newText": ""
                    }]
                }]
            }
        }));
        assert!(invalid.validate().is_err());
    }
}

use opcore::api::test_support::{
    AnalysisError, CancelToken, DependencyExtractionStatus, FingerprintExtractionStatus,
    InterfaceExtractionStatus, Language, RepoPath, SourceFile, hcl,
};

fn source(path: &str, text: impl AsRef<[u8]>, mode: &str) -> SourceFile {
    SourceFile::new(
        RepoPath::from_protocol(path).expect("fixture path"),
        text.as_ref(),
        Language::Hcl,
        mode.into(),
    )
}

#[test]
fn parses_terraform_opentofu_and_terragrunt_native_hcl() {
    for (path, mode, text) in [
        (
            "main.tf",
            "hcl:terraform:native",
            r#"
terraform { required_version = ">= 1.8" }
resource "example_service" "main" {
  name = var.name
  tags = { environment = "test" }
}
"#,
        ),
        (
            "main.tofu",
            "hcl:opentofu:native",
            r#"
tofu {
  required_version = ">= 1.8"
}
"#,
        ),
        (
            "terragrunt.hcl",
            "hcl:terragrunt:native",
            r#"
terraform { source = "../module" }
inputs = {
  environment = "development"
}
"#,
        ),
    ] {
        let facts = hcl::analyze(&source(path, text, mode), &CancelToken::new())
            .unwrap_or_else(|error| panic!("{path}: {error}"));
        assert!(facts.diagnostics.is_empty(), "{path}");
        assert_eq!(facts.parser, "hcl-edit");
        assert_eq!(facts.parser_version, "0.9.6");
        assert_eq!(
            facts.dependencies.status,
            DependencyExtractionStatus::Unsupported
        );
        assert_eq!(
            facts.callable_fingerprints.status,
            FingerprintExtractionStatus::Unsupported
        );
        assert!(matches!(
            facts.region_fingerprints.status,
            FingerprintExtractionStatus::Unsupported
        ));
        assert_eq!(
            facts.interfaces.status,
            InterfaceExtractionStatus::Unsupported
        );
    }
}

#[test]
fn parses_hcl_json_and_requires_an_object_root() {
    let valid = hcl::analyze(
        &source(
            "main.tf.json",
            r#"{"resource":{"example_service":{"main":{"name":"test"}}}}"#,
            "hcl:terraform:json",
        ),
        &CancelToken::new(),
    )
    .expect("valid HCL JSON");
    assert!(valid.diagnostics.is_empty());
    assert_eq!(valid.parser, "serde_json");
    assert_eq!(valid.parser_version, "1.0.151");

    let scalar = hcl::analyze(
        &source("main.tf.json", "true", "hcl:terraform:json"),
        &CancelToken::new(),
    )
    .expect("root shape is a syntax finding");
    assert_eq!(scalar.diagnostics.len(), 1);
    assert_eq!(scalar.diagnostics[0].rule_id, "hcl.syntax");
    assert_eq!(scalar.diagnostics[0].evidence["errorKind"], "root-type");
}

#[test]
fn parses_tfvars_json_examples_as_json() {
    let valid = hcl::analyze(
        &source(
            "dev.auto.tfvars.json.example",
            r#"{"region":"us-east-1"}"#,
            "hcl:terraform-vars:json",
        ),
        &CancelToken::new(),
    )
    .expect("valid tfvars JSON example");
    assert!(valid.diagnostics.is_empty());
    assert_eq!(valid.parser, "serde_json");

    let malformed = hcl::analyze(
        &source(
            "dev.auto.tfvars.json.example",
            r#"{"region":}"#,
            "hcl:terraform-vars:json",
        ),
        &CancelToken::new(),
    )
    .expect("invalid tfvars JSON example is a finding");
    assert_eq!(malformed.diagnostics.len(), 1);
    assert_eq!(malformed.diagnostics[0].rule_id, "hcl.syntax");
    assert_eq!(malformed.diagnostics[0].evidence["parser"], "serde_json");
}

#[test]
fn native_and_json_syntax_findings_are_ranged_and_identify_the_parser() {
    for (path, mode, text, parser) in [
        (
            "main.tf",
            "hcl:terraform:native",
            "resource \"x\" \"y\" {\n  value = [1,\n}\n",
            "hcl-edit",
        ),
        (
            "main.tf.json",
            "hcl:terraform:json",
            "{\n  \"resource\": ]\n}\n",
            "serde_json",
        ),
    ] {
        let facts = hcl::analyze(&source(path, text, mode), &CancelToken::new())
            .expect("syntax errors are findings");
        assert_eq!(facts.diagnostics.len(), 1, "{path}");
        let diagnostic = &facts.diagnostics[0];
        assert_eq!(diagnostic.rule_id, "hcl.syntax");
        assert!(diagnostic.range.is_some());
        assert_eq!(diagnostic.evidence["parser"], parser);
    }
}

#[test]
fn invalid_utf8_is_a_syntax_finding_and_extreme_depth_is_incomplete() {
    let invalid = hcl::analyze(
        &source("main.tf", b"value = \"\xff\"\n", "hcl:terraform:native"),
        &CancelToken::new(),
    )
    .expect("invalid UTF-8 is a finding");
    assert_eq!(invalid.diagnostics[0].evidence["errorKind"], "invalid_utf8");

    let deep = format!("value = {}0{}\n", "[".repeat(257), "]".repeat(257));
    assert!(matches!(
        hcl::analyze(
            &source("main.tf", deep, "hcl:terraform:native"),
            &CancelToken::new()
        ),
        Err(AnalysisError::Unsupported(message)) if message.contains("delimiter depth")
    ));
}

use opcore::api::test_support::{
    AnalysisError, CancelToken, DependencyExtractionStatus, FingerprintExtractionStatus,
    InterfaceExtractionStatus, Language, RepoPath, SourceFile, shell,
};

fn source(path: &str, text: impl AsRef<[u8]>, dialect: &str) -> SourceFile {
    SourceFile::new(
        RepoPath::from_protocol(path).expect("fixture path"),
        text.as_ref(),
        Language::Shell,
        format!("shell:{dialect}:{}", std::env::consts::OS),
    )
}

#[test]
fn parses_bash_and_declared_sh_with_host_os_provenance() {
    for (path, dialect, text) in [
        (
            "script.bash",
            "bash",
            "#!/usr/bin/env bash\nvalues=(one two)\n[[ -n ${values[0]} ]]\n",
        ),
        (
            "script.sh",
            "sh",
            "#!/bin/sh\nfor value in one two; do\n  printf '%s\\n' \"$value\"\ndone\n",
        ),
    ] {
        let facts = shell::analyze(&source(path, text, dialect), &CancelToken::new())
            .unwrap_or_else(|error| panic!("{path}: {error}"));
        assert!(facts.diagnostics.is_empty(), "{path}");
        assert_eq!(facts.parser, "shuck-parser");
        assert_eq!(facts.parser_version, "0.1.1");
        assert_eq!(
            facts.dependencies.status,
            DependencyExtractionStatus::Unsupported
        );
        assert_eq!(
            facts.callable_fingerprints.status,
            FingerprintExtractionStatus::Unsupported
        );
        assert_eq!(
            facts.region_fingerprints.status,
            FingerprintExtractionStatus::Unsupported
        );
        assert_eq!(
            facts.interfaces.status,
            InterfaceExtractionStatus::Unsupported
        );
    }
}

#[test]
fn declared_sh_rejects_bash_conditionals() {
    let facts = shell::analyze(
        &source("script.sh", "[[ -n value ]]\n", "sh"),
        &CancelToken::new(),
    )
    .expect("dialect mismatch is a syntax finding");
    assert!(!facts.diagnostics.is_empty());
    assert!(
        facts
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.rule_id == "shell.syntax")
    );
    assert_eq!(facts.diagnostics[0].evidence["dialect"], "sh");
    assert_eq!(facts.diagnostics[0].evidence["parserDialect"], "posix");
    assert_eq!(
        facts.diagnostics[0].evidence["hostOs"],
        std::env::consts::OS
    );
}

#[test]
fn syntax_and_utf8_findings_are_ranged() {
    let syntax = shell::analyze(
        &source("script.bash", "if true; then\n  echo missing\n", "bash"),
        &CancelToken::new(),
    )
    .expect("syntax errors are findings");
    assert!(!syntax.diagnostics.is_empty());
    assert!(syntax.diagnostics[0].range.is_some());
    assert_eq!(syntax.diagnostics[0].evidence["parser"], "shuck-parser");

    let invalid = shell::analyze(
        &source("script.sh", b"printf '\xff'\n", "sh"),
        &CancelToken::new(),
    )
    .expect("invalid UTF-8 is a finding");
    assert_eq!(invalid.diagnostics[0].evidence["errorKind"], "invalid_utf8");
    assert!(invalid.diagnostics[0].range.is_some());
}

#[test]
fn host_os_mismatch_and_extreme_depth_are_incomplete() {
    let other_os = if std::env::consts::OS == "linux" {
        "macos"
    } else {
        "linux"
    };
    let mismatched = SourceFile::new(
        RepoPath::from_protocol("script.sh").expect("fixture path"),
        b"echo test\n".as_slice(),
        Language::Shell,
        format!("shell:sh:{other_os}"),
    );
    assert!(matches!(
        shell::analyze(&mismatched, &CancelToken::new()),
        Err(AnalysisError::Unsupported(message)) if message.contains("current host OS")
    ));

    let deep = format!("echo {}true{}\n", "$(".repeat(65), ")".repeat(65));
    assert!(matches!(
        shell::analyze(
            &source("script.bash", deep, "bash"),
            &CancelToken::new()
        ),
        Err(AnalysisError::Unsupported(message)) if message.contains("delimiter depth")
    ));
}

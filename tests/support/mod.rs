#![allow(dead_code)]

use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

use serde_json::Value;

use opcore::api::test_support::{FileFacts, FingerprintExtractionStatus};

pub struct RepositoryFixture {
    _root: tempfile::TempDir,
    repo: std::path::PathBuf,
    cache: std::path::PathBuf,
}

impl RepositoryFixture {
    pub fn new(files: &[(&str, &str)]) -> Self {
        let root = tempfile::tempdir().unwrap();
        let repository = root.path().join("repo");
        let cache = root.path().join("cache");
        fs::create_dir_all(&repository).unwrap();
        for args in [
            &["init", "-q"][..],
            &["config", "user.name", "Test"][..],
            &["config", "user.email", "test@example.com"][..],
        ] {
            git(&repository, args);
        }
        for (path, source) in files {
            write_source(&repository, path, source);
        }
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-qm", "initial"]);
        Self {
            _root: root,
            repo: repository,
            cache,
        }
    }

    pub fn repo(&self) -> &Path {
        &self.repo
    }

    pub fn cache(&self) -> &Path {
        &self.cache
    }

    pub fn write(&self, path: &str, source: &str) {
        write_source(&self.repo, path, source);
    }
}

pub fn write_source(repo: &Path, path: &str, source: &str) {
    let absolute = repo.join(path);
    fs::create_dir_all(absolute.parent().unwrap()).unwrap();
    fs::write(absolute, source).unwrap();
}

pub fn git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

pub fn sense(repo: &Path, cache: &Path, advisory: bool) -> Output {
    sense_with_mode(repo, cache, advisory, false)
}

pub fn sense_staged(repo: &Path, cache: &Path, advisory: bool) -> Output {
    sense_with_mode(repo, cache, advisory, true)
}

pub fn sense_advisory_allow_partial(repo: &Path, cache: &Path) -> Output {
    opcore(
        repo,
        cache,
        "sense",
        &["--json", "--advisory", "--allow-partial"],
    )
}

fn sense_with_mode(repo: &Path, cache: &Path, advisory: bool, staged: bool) -> Output {
    let mut options = vec!["--json"];
    if advisory {
        options.push("--advisory");
    }
    if staged {
        options.push("--staged");
    }
    opcore(repo, cache, "sense", &options)
}

pub fn opcore(repo: &Path, cache: &Path, subcommand: &str, options: &[&str]) -> Output {
    Command::new(assert_cmd::cargo::cargo_bin!("opcore"))
        .args([subcommand, "--repo"])
        .arg(repo)
        .args(options)
        .env("XDG_CACHE_HOME", cache)
        .output()
        .unwrap()
}

pub fn opcore_json(fixture: &RepositoryFixture, subcommand: &str, options: &[&str]) -> Output {
    let mut arguments = vec!["--json"];
    arguments.extend_from_slice(options);
    opcore(fixture.repo(), fixture.cache(), subcommand, &arguments)
}

pub fn json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "invalid JSON: {error}\nstdout={}\nstderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

pub fn blocking_sense(repo: &Path, cache: &Path) -> Value {
    let output = sense(repo, cache, false);
    assert!(!output.status.success());
    json(&output)
}

pub fn assert_clean_sense(repo: &Path, cache: &Path) {
    let output = sense(repo, cache, false);
    assert!(output.status.success());
    assert_eq!(json(&output)["status"], "clean");
}

pub fn assert_region_duplicate<'a>(
    report: &'a Value,
    language_family: &str,
    before_count: u64,
    after_count: u64,
) -> &'a Value {
    let findings = report["introducedDuplicates"].as_array().unwrap();
    assert_eq!(findings.len(), 1, "{findings:?}");
    let finding = &findings[0];
    assert_eq!(finding["kind"], "token_region");
    assert_eq!(finding["languageFamily"], language_family);
    assert_eq!(finding["beforeCount"], before_count);
    assert_eq!(finding["afterCount"], after_count);
    assert_eq!(finding["introducedCount"], after_count - before_count);
    assert!(
        finding["tokenCount"]
            .as_u64()
            .is_some_and(|count| count >= 48)
    );
    finding
}

pub fn assert_fingerprints_parser_failed(facts: &FileFacts) {
    assert_eq!(
        facts.callable_fingerprints.status,
        FingerprintExtractionStatus::ParserFailed
    );
    assert!(facts.callable_fingerprints.callables.is_empty());
    assert_eq!(
        facts.region_fingerprints.status,
        FingerprintExtractionStatus::ParserFailed
    );
    assert!(facts.region_fingerprints.anchors.is_empty());
}

#![cfg(unix)]

mod support;
use support::{RepositoryFixture, json, opcore, opcore_json};

fn full_check(fixture: &RepositoryFixture) -> serde_json::Value {
    let output = opcore_json(fixture, "check", &["--all"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    json(&output)
}

#[test]
fn empty_change_selections_are_non_blocking_but_not_reported_clean() {
    let fixture = RepositoryFixture::new(&[("src/a.ts", "export const value = 1;\n")]);

    for options in [
        Vec::<&str>::new(),
        vec!["--changed"],
        vec!["--staged"],
        vec!["--advisory"],
        vec!["--changed", "--advisory"],
    ] {
        let output = opcore_json(&fixture, "check", &options);
        assert!(
            output.status.success(),
            "{options:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let assessment = json(&output);
        assert_eq!(assessment["status"], "not_checked", "{options:?}");
        assert_eq!(assessment["coverage"]["filesConsidered"], 0);
        assert_eq!(assessment["coverage"]["gaps"][0]["status"], "not_checked");
    }

    assert_eq!(full_check(&fixture)["status"], "clean");
}

#[test]
fn unsupported_source_is_a_non_blocking_coverage_warning() {
    let fixture = RepositoryFixture::new(&[("scripts/check.ps1", "Write-Output 'ok'\n")]);

    let assessment = full_check(&fixture);
    assert_eq!(assessment["status"], "clean");
    assert_eq!(assessment["coverage"]["filesConsidered"], 1);
    assert_eq!(assessment["coverage"]["filesCovered"], 0);
    assert_eq!(assessment["coverage"]["gaps"][0]["status"], "unsupported");

    let human = opcore(fixture.repo(), fixture.cache(), "check", &["--all"]);
    assert!(human.status.success());
    let rendered = String::from_utf8(human.stdout).unwrap();
    assert!(rendered.contains("0/1 files covered, 1 coverage warnings"));
    assert!(rendered.contains("warning: unsupported coverage"));
}

#[test]
fn supported_and_unsupported_sources_can_report_clean_together() {
    let fixture = RepositoryFixture::new(&[
        ("src/ready.ts", "export const ready = true;\n"),
        ("scripts/check.ps1", "Write-Output 'ok'\n"),
    ]);

    let assessment = full_check(&fixture);
    assert_eq!(assessment["status"], "clean");
    assert_eq!(assessment["coverage"]["filesConsidered"], 2);
    assert_eq!(assessment["coverage"]["filesCovered"], 1);
    assert_eq!(assessment["coverage"]["gaps"][0]["status"], "unsupported");
}

#[test]
fn full_view_without_source_candidates_is_non_blocking_not_checked() {
    let fixture = RepositoryFixture::new(&[("README.md", "# Documentation\n")]);

    let assessment = full_check(&fixture);
    assert_eq!(assessment["status"], "not_checked");
    assert_eq!(assessment["coverage"]["filesConsidered"], 0);
    assert_eq!(assessment["coverage"]["gaps"][0]["status"], "not_checked");
}

#![cfg(unix)]

mod support;
use support::{RepositoryFixture, json, opcore_json};

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

    let all = opcore_json(&fixture, "check", &["--all"]);
    assert!(all.status.success());
    assert_eq!(json(&all)["status"], "clean");
}

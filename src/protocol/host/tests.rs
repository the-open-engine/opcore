//! Focused tests for the minimal bundled-provider host.

use super::*;
use crate::protocol::asp::{CAPABILITY_VERSION, build_digest};

fn workspace() -> HostWorkspace {
    HostWorkspace::new(json!({ "rev": "git:tree:test" })).unwrap()
}

fn request() -> HostRequest {
    HostRequest::new(
        workspace(),
        json!({
            "changeset": {
                "baseline": { "rev": "git:tree:test" },
                "changes": []
            },
            "scope": "changeset",
            "comparison": "introduced"
        }),
    )
    .unwrap()
}

fn valid_assessment() -> Value {
    let request = request();
    let changeset = &request.evaluation_params["changeset"];
    let changeset_digest = format!(
        "sha256:{}",
        hex::encode(Sha256::digest(serde_json::to_vec(changeset).unwrap()))
    );
    let coverage = json!({
        "scope": "changeset",
        "diagnosticSources": [ProviderProfile::Fast.provider_id()],
        "rules": [ProviderProfile::Fast.rule()],
        "comparison": "introduced"
    });
    json!({
        "status": "complete",
        "diagnostics": [],
        "coverage": {
            "requested": coverage,
            "covered": coverage,
            "degraded": [],
            "unsupported": [],
            "exhaustive": true,
            "truncated": false
        },
        "validAsOf": {
            "baseline": request.workspace.baseline(),
            "changesetDigest": changeset_digest,
            "blobs": []
        },
        "provider": {
            "id": ProviderProfile::Fast.provider_id(),
            "version": env!("CARGO_PKG_VERSION"),
            "configDigest": crate::protocol::asp::configuration_digest(None, ProviderProfile::Fast).unwrap(),
            "capabilityVersion": CAPABILITY_VERSION,
            "buildDigest": build_digest(),
            "capabilityFamily": "check"
        },
        "timing": { "elapsedMs": 1 },
        "cache": { "status": "disabled" }
    })
}

#[test]
fn host_rejects_configuration_digest_mismatch() {
    let mut request = request();
    request.evaluation_params["configuration"] = json!({"verify": {"maxParameters": 2}});
    let mut assessment = valid_assessment();
    let error = validation::validate_assessment(
        assessment.clone(),
        &request,
        ProviderProfile::Fast,
        &BTreeSet::new(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("config digest"));

    assessment["provider"]["configDigest"] = json!(
        crate::protocol::asp::configuration_digest(
            request.evaluation_params.get("configuration"),
            ProviderProfile::Fast,
        )
        .unwrap()
    );
    assert!(
        validation::validate_assessment(
            assessment,
            &request,
            ProviderProfile::Fast,
            &BTreeSet::new(),
        )
        .is_ok()
    );
}

#[test]
fn callback_view_is_content_addressed_and_path_scoped() {
    let mut workspace = workspace();
    let path = RepoPath::from_protocol("src/lib.rs").unwrap();
    let blob = workspace
        .add_baseline_file(path, Arc::<[u8]>::from(b"fn main() {}\n".as_slice()))
        .unwrap();
    assert_eq!(
        workspace
            .add_candidate_blob(Arc::<[u8]>::from(b"fn main() {}\n".as_slice()))
            .unwrap(),
        blob
    );
    let listed = workspace
        .list_tree(&json!({
            "baseline": { "rev": "git:tree:test" },
            "paths": ["src/lib.rs", "src/missing.rs"]
        }))
        .unwrap();
    assert_eq!(listed["entries"].as_array().unwrap().len(), 1);
    let read = workspace.read_blobs(&json!({ "blobs": [blob] })).unwrap();
    assert_eq!(read["blobs"][0]["encoding"], "base64");
    assert_eq!(
        read["blobs"][0]["bytes"],
        base64::engine::general_purpose::STANDARD.encode(b"fn main() {}\n")
    );
}

#[test]
fn callback_view_rejects_unknown_blobs_and_stale_baselines() {
    let workspace = workspace();
    assert!(
        workspace
            .list_tree(&json!({ "baseline": { "rev": "other" } }))
            .is_err()
    );
    assert!(
        workspace
            .read_blobs(&json!({ "blobs": ["blob:sha256:missing"] }))
            .is_err()
    );
}

#[test]
fn frame_reader_requires_one_bounded_nonempty_line() {
    let mut valid = BufReader::new(b"{\"jsonrpc\":\"2.0\"}\r\n".as_slice());
    assert_eq!(
        read_frame(&mut valid).unwrap().unwrap(),
        br#"{"jsonrpc":"2.0"}"#
    );
    let mut empty = BufReader::new(b"\n".as_slice());
    assert!(read_frame(&mut empty).is_err());
    let bytes = vec![b'x'; MAX_FRAME_BYTES + 1];
    let mut oversized = BufReader::new(bytes.as_slice());
    assert!(read_frame(&mut oversized).is_err());
}

#[test]
fn callback_request_ids_reject_fractional_numbers() {
    assert!(valid_request_id(&json!(1)));
    assert!(valid_request_id(&json!("one")));
    assert!(!valid_request_id(&json!(1.5)));
    assert!(!valid_request_id(&Value::Null));
}

#[test]
fn assessment_timestamps_require_rfc3339() {
    assert!(
        validation::validate_timing(Some(&json!({
            "startedAt": "not-a-date",
            "endedAt": "2026-09-04T12:34:56Z"
        })))
        .is_err()
    );
    assert!(
        validation::validate_cache(Some(&json!({
            "status": "hit",
            "refreshedAt": "2026-09-04T12:34:56Z"
        })))
        .is_ok()
    );
}

#[test]
fn lifecycle_timing_reserves_startup_and_shutdown() {
    let started = Instant::now();
    let timing = LifecycleTiming::new(started, MAX_WALLCLOCK_MS).unwrap();
    assert_eq!(timing.provider_wallclock_ms, MAX_WALLCLOCK_MS - 2_000);
    assert_eq!(
        timing.evaluation_deadline.duration_since(started),
        Duration::from_millis(MAX_WALLCLOCK_MS)
            .checked_sub(PROVIDER_SHUTDOWN_RESERVE)
            .unwrap()
    );
    assert_eq!(
        timing.shutdown_deadline.duration_since(started),
        Duration::from_millis(MAX_WALLCLOCK_MS)
    );
    assert!(LifecycleTiming::new(started, 2_000).is_err());
}

#[test]
fn blocked_provider_stdin_write_obeys_deadline_and_cleanup() {
    let mut provider = ProviderProcess::spawn(&ProviderCommand::new("/bin/sleep", ["30"]))
        .expect("spawn provider that keeps stdin open without reading it");
    let pid = Pid::from_child(&provider.child);
    let payload = json!({ "padding": "x".repeat(2 * 1024 * 1024) });
    let started = Instant::now();

    let error = provider
        .send(&payload, started + Duration::from_millis(250))
        .expect_err("a full provider pipe must not outlive the write deadline");

    assert!(
        error
            .to_string()
            .contains("write exceeded its wallclock grant"),
        "unexpected blocked-write error: {error:#}"
    );
    provider.terminate();
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "blocked provider cleanup exceeded its bounded test allowance"
    );
    assert!(rustix::process::test_kill_process(pid).is_err());
}

#[test]
fn assessment_rejects_blob_read_set_mismatch() {
    let request = request();
    let read_blobs = BTreeSet::from(["blob:sha256:actually-read".to_owned()]);

    let error = validate_assessment(
        valid_assessment(),
        &request,
        ProviderProfile::Fast,
        &read_blobs,
    )
    .expect_err("assessment must cite the host-observed blob read set exactly");

    assert!(
        error.to_string().contains("blob read set does not match"),
        "unexpected read-set validation error: {error:#}"
    );
}

#[test]
fn assessment_rejects_nested_host_owned_field() {
    let request = request();
    for field in ["decision", "apply", "fail"] {
        let mut assessment = valid_assessment();
        assessment["evidence"] = json!([{
            "kind": "metric",
            "data": { "nested": {} }
        }]);
        assessment["evidence"][0]["data"]["nested"][field] = json!(true);

        let error = validate_assessment(
            assessment,
            &request,
            ProviderProfile::Fast,
            &BTreeSet::new(),
        )
        .expect_err("host-owned fields must be rejected at every nesting level");

        assert!(
            error.to_string().contains("host-owned field"),
            "unexpected host-field validation error: {error:#}"
        );
    }
}

#[test]
fn provider_working_directory_is_outside_the_candidate() {
    let candidate = tempfile::Builder::new()
        .prefix("opcore-candidate-")
        .tempdir_in("/tmp")
        .unwrap();
    let provider = private_provider_directory(Some(candidate.path())).unwrap();

    assert!(!provider.path().starts_with(candidate.path()));
}

#[test]
fn termination_kills_provider_group_descendants() {
    let directory = tempfile::tempdir().unwrap();
    let pid_path = directory.path().join("descendant.pid");
    let arguments = vec![
        OsString::from("-c"),
        OsString::from("/bin/sleep 30 & printf '%s' \"$!\" > \"$1\"; wait"),
        OsString::from("opcore-provider-test"),
        pid_path.as_os_str().to_owned(),
    ];
    let mut provider = ProviderProcess::spawn(&ProviderCommand::new("/bin/sh", arguments)).unwrap();
    let descendant = wait_for_recorded_pid(&pid_path);
    let group = provider.process_group.unwrap();
    assert_eq!(rustix::process::getpgid(Some(descendant)).unwrap(), group);

    provider.terminate();

    assert!(wait_for_process_exit(descendant));
}

fn wait_for_recorded_pid(path: &std::path::Path) -> Pid {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(value) = std::fs::read_to_string(path)
            && let Ok(raw) = value.parse::<i32>()
            && let Some(pid) = Pid::from_raw(raw)
        {
            return pid;
        }
        assert!(Instant::now() < deadline, "descendant pid was not recorded");
        thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_process_exit(pid: Pid) -> bool {
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if rustix::process::test_kill_process(pid).is_err() {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    false
}

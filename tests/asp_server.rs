use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn provider_command() -> Command {
    let mut command = Command::new(assert_cmd::cargo::cargo_bin!("opcore"));
    command.args(["serve", "--stdio"]).stdin(Stdio::piped());
    command
}

fn start_provider(capture_stderr: bool) -> (Child, ChildStdin, BufReader<ChildStdout>) {
    let mut child = provider_command()
        .stdout(Stdio::piped())
        .stderr(if capture_stderr {
            Stdio::piped()
        } else {
            Stdio::inherit()
        })
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let stdout = BufReader::new(child.stdout.take().unwrap());
    (child, stdin, stdout)
}

fn send(stdin: &mut impl Write, value: &Value) {
    serde_json::to_writer(&mut *stdin, value).unwrap();
    stdin.write_all(b"\n").unwrap();
    stdin.flush().unwrap();
}

fn receive(stdout: &mut impl BufRead) -> Value {
    let mut line = String::new();
    assert!(
        stdout.read_line(&mut line).unwrap() > 0,
        "provider closed stdout"
    );
    serde_json::from_str(&line).unwrap()
}

fn blob_ref(bytes: &[u8]) -> String {
    format!("blob:sha256:{}", hex::encode(Sha256::digest(bytes)))
}

#[test]
fn canonical_lifecycle_callbacks_and_assessment() {
    let (child, mut stdin, mut stdout) = start_provider(true);
    let baseline = json!({ "rev": "git:tree:test" });
    initialize_provider(&mut stdin, &mut stdout, &baseline);
    let source = b"def overloaded(a, b, c, d, e, f):\n    return a\n";
    let (evaluation, after) = evaluate_source(&mut stdin, &mut stdout, &baseline, source);
    assert_assessment(&evaluation, &baseline, &after);
    assert_eq!(
        evaluation["result"]["evidence"][0]["data"]["cacheMisses"],
        1
    );
    assert_eq!(
        evaluation["result"]["evidence"][0]["data"]["filesParsed"],
        1
    );
    let (warm, _) = evaluate_source(&mut stdin, &mut stdout, &baseline, source);
    assert_eq!(warm["result"]["evidence"][0]["data"]["cacheHits"], 1);
    assert_eq!(warm["result"]["evidence"][0]["data"]["cacheMisses"], 0);
    assert_eq!(warm["result"]["evidence"][0]["data"]["filesParsed"], 0);
    shutdown_provider(&mut stdin, &mut stdout);
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn initialize_provider(stdin: &mut impl Write, stdout: &mut impl BufRead, baseline: &Value) {
    send(
        stdin,
        &json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "asp/1.0",
                "host": { "name": "test-host", "version": "0.1.0" },
                "workspace": { "root": "/candidate", "baseline": baseline }
            }
        }),
    );
    let initialized = receive(stdout);
    assert_eq!(initialized["id"], 1);
    assert_eq!(
        initialized["result"]["capabilityFamilies"],
        json!(["check"])
    );
    assert_eq!(
        initialized["result"]["capabilities"]["check"]["capabilityVersion"],
        "check/1.0"
    );
    assert_eq!(
        initialized["result"]["capabilities"]["check"]["partialResults"],
        false
    );
    assert_eq!(
        initialized["result"]["capabilities"]["check"]["incremental"],
        false
    );
    send(
        stdin,
        &json!({
            "jsonrpc": "2.0", "method": "initialized", "params": {
                "grantedPermissions": {
                    "read": ["**/*"], "write": false, "network": false,
                    "resourceLimits": { "wallclockMs": 5_000 }
                },
                "baseline": baseline
            }
        }),
    );
}

fn initialize_minimal_provider(
    stdin: &mut impl Write,
    stdout: &mut impl BufRead,
    baseline: &Value,
    wallclock_ms: u64,
) {
    send(
        stdin,
        &json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "asp/1.0", "host": { "name": "test", "version": "1" },
                "workspace": { "root": "/candidate", "baseline": baseline }
            }
        }),
    );
    assert_eq!(receive(stdout)["id"], 1);
    send(
        stdin,
        &json!({
            "jsonrpc": "2.0", "method": "initialized", "params": {
                "grantedPermissions": {
                    "read": ["**/*"], "resourceLimits": { "wallclockMs": wallclock_ms }
                },
                "baseline": baseline
            }
        }),
    );
}

fn evaluate_source(
    stdin: &mut impl Write,
    stdout: &mut impl BufRead,
    baseline: &Value,
    source: &[u8],
) -> (Value, String) {
    let after = blob_ref(source);
    let changeset = json!({
        "baseline": baseline,
        "changes": [{ "path": "src/a.py", "kind": "create", "after": after }]
    });
    send(
        stdin,
        &json!({
            "jsonrpc": "2.0", "id": "evaluation", "method": "check/evaluate", "params": {
                "changeset": changeset, "scope": "changeset", "comparison": "introduced"
            }
        }),
    );

    let list_request = receive(stdout);
    assert_eq!(list_request["method"], "workspace/listTree");
    assert_eq!(list_request["params"]["paths"], json!(["src/a.py"]));
    send(
        stdin,
        &json!({
            "jsonrpc": "2.0", "id": list_request["id"], "result": { "entries": [], "truncated": false }
        }),
    );
    let blob_request = receive(stdout);
    assert_eq!(
        blob_request["method"], "workspace/readBlob",
        "unexpected provider frame: {blob_request}"
    );
    assert_eq!(blob_request["params"]["blobs"], json!([after]));
    send(
        stdin,
        &json!({
            "jsonrpc": "2.0", "id": blob_request["id"], "result": { "blobs": [{
                "id": after, "encoding": "utf-8", "bytes": String::from_utf8_lossy(source)
            }]}
        }),
    );
    (receive(stdout), after)
}

fn assert_assessment(evaluation: &Value, baseline: &Value, after: &str) {
    assert_eq!(evaluation["id"], "evaluation");
    let assessment = &evaluation["result"];
    assert_eq!(
        assessment["status"], "complete",
        "unexpected evaluation frame: {evaluation}"
    );
    assert_eq!(assessment["provider"]["id"], "opcore");
    assert_eq!(assessment["validAsOf"]["baseline"], *baseline);
    assert_eq!(assessment["validAsOf"]["blobs"], json!([after]));
    assert_eq!(assessment["coverage"]["exhaustive"], true);
    assert_eq!(
        assessment["evidence"][0]["data"]["initializedGrant"]["read"],
        json!(["**/*"])
    );
    assert_eq!(
        assessment["evidence"][0]["data"]["initializedGrant"]["write"],
        false
    );
    assert_eq!(
        assessment["evidence"][0]["data"]["initializedGrant"]["network"],
        false
    );
    assert!(
        assessment["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| { diagnostic["code"] == "opcore/complexity.max-parameters" })
    );
    let forbidden = [
        "decision",
        "verdict",
        "pass",
        "authority",
        "assurance",
        "receipt",
    ];
    let serialized = serde_json::to_string(assessment).unwrap();
    for field in forbidden {
        assert!(!serialized.contains(&format!("\"{field}\"")));
    }
}

fn shutdown_provider(stdin: &mut impl Write, stdout: &mut impl BufRead) {
    send(
        stdin,
        &json!({ "jsonrpc": "2.0", "id": 9, "method": "shutdown" }),
    );
    assert_eq!(receive(stdout)["result"], Value::Null);
    send(stdin, &json!({ "jsonrpc": "2.0", "method": "exit" }));
}

#[test]
fn rejects_capability_work_before_initialized() {
    let (mut child, mut stdin, mut stdout) = start_provider(false);
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0", "id": 1, "method": "check/evaluate", "params": {}
        }),
    );
    let response = receive(&mut stdout);
    assert_eq!(response["error"]["code"], -32010);
    assert_eq!(response["error"]["message"], "provider-not-initialized");
    assert_eq!(response["error"]["data"]["failClass"], "health");
    assert_eq!(response["error"]["data"]["retryable"], true);
    let baseline = json!({ "rev": "tree:not-initialized" });
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {
                "protocolVersion": "asp/1.0",
                "host": { "name": "test-host", "version": "0.1.0" },
                "workspace": { "root": "/candidate", "baseline": baseline }
            }
        }),
    );
    assert_eq!(receive(&mut stdout)["id"], 2);
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0", "method": "initialized", "params": {
                "grantedPermissions": {
                    "read": ["**/*"], "write": true, "network": false,
                    "resourceLimits": { "wallclockMs": 1_000 }
                },
                "baseline": baseline
            }
        }),
    );
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0", "id": 3, "method": "check/evaluate", "params": {}
        }),
    );
    let after_rejected_grant = receive(&mut stdout);
    assert_eq!(after_rejected_grant["error"]["code"], -32010);
    assert_eq!(
        after_rejected_grant["error"]["message"],
        "provider-not-initialized"
    );
    send(
        &mut stdin,
        &json!({ "jsonrpc": "2.0", "id": 4, "method": "shutdown" }),
    );
    let _ = receive(&mut stdout);
    send(&mut stdin, &json!({ "jsonrpc": "2.0", "method": "exit" }));
    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn rejects_unsupported_protocol_with_typed_version_error() {
    let (mut child, mut stdin, mut stdout) = start_provider(false);
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "asp/0.1",
                "host": { "name": "test-host", "version": "0.1.0" },
                "workspace": { "root": "/candidate", "baseline": { "rev": "tree:test" } }
            }
        }),
    );
    let response = receive(&mut stdout);
    assert_eq!(response["error"]["code"], -32014);
    assert_eq!(response["error"]["message"], "unsupported-version");
    assert_eq!(response["error"]["data"]["failClass"], "contract");
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn cancellation_interrupts_an_outstanding_host_callback() {
    let (mut child, mut stdin, mut stdout) = start_provider(false);
    let baseline = json!({ "rev": "git:tree:cancel" });
    initialize_minimal_provider(&mut stdin, &mut stdout, &baseline, 30_000);
    let source = b"def ok():\n    pass\n";
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0", "id": "cancel-me", "method": "check/evaluate", "params": {
                "changeset": { "baseline": baseline, "changes": [{
                    "path": "a.py", "kind": "create", "after": blob_ref(source)
                }]},
                "scope": "changeset", "comparison": "introduced"
            }
        }),
    );
    let callback = receive(&mut stdout);
    assert_eq!(callback["method"], "workspace/listTree");
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0", "method": "$/cancelRequest", "params": { "id": "cancel-me" }
        }),
    );
    let cancelled = receive(&mut stdout);
    assert_eq!(cancelled["id"], "cancel-me");
    assert_eq!(cancelled["error"]["code"], -32016);
    assert_eq!(cancelled["error"]["data"]["retryable"], true);
    send(
        &mut stdin,
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "shutdown" }),
    );
    let _ = receive(&mut stdout);
    send(&mut stdin, &json!({ "jsonrpc": "2.0", "method": "exit" }));
    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn malformed_frames_duplicate_keys_and_duplicate_live_ids_fail_closed() {
    let (child, mut stdin, mut stdout) = start_provider(true);

    stdin.write_all(b"{bad json}\n").unwrap();
    stdin.flush().unwrap();
    assert_eq!(receive(&mut stdout)["error"]["code"], -32700);
    stdin
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"id\":2,\"method\":\"initialize\"}\n")
        .unwrap();
    stdin.flush().unwrap();
    assert_eq!(receive(&mut stdout)["error"]["code"], -32700);

    let baseline = json!({ "rev": "git:tree:duplicates" });
    initialize_minimal_provider(&mut stdin, &mut stdout, &baseline, 30_000);
    let source = b"def ok():\n    pass\n";
    let request = json!({
        "jsonrpc": "2.0", "id": "same", "method": "check/evaluate", "params": {
            "changeset": { "baseline": baseline, "changes": [{
                "path": "a.py", "kind": "create", "after": blob_ref(source)
            }]},
            "scope": "changeset", "comparison": "introduced"
        }
    });
    send(&mut stdin, &request);
    assert_eq!(receive(&mut stdout)["method"], "workspace/listTree");
    let mut competing = request.clone();
    competing["id"] = Value::String("other".into());
    send(&mut stdin, &competing);
    let unavailable = receive(&mut stdout);
    assert_eq!(unavailable["id"], "other");
    assert_eq!(unavailable["error"]["code"], -32015);
    assert_eq!(unavailable["error"]["data"]["retryable"], true);
    send(&mut stdin, &request);
    let duplicate = receive(&mut stdout);
    assert_eq!(duplicate["id"], "same");
    assert_eq!(duplicate["error"]["code"], -32600);
    send(
        &mut stdin,
        &json!({ "jsonrpc": "2.0", "method": "$/cancelRequest", "params": { "id": "same" } }),
    );
    assert_eq!(receive(&mut stdout)["error"]["code"], -32016);

    send(
        &mut stdin,
        &json!({ "jsonrpc": "2.0", "id": 9, "method": "shutdown" }),
    );
    assert_eq!(receive(&mut stdout)["result"], Value::Null);
    send(&mut stdin, &json!({ "jsonrpc": "2.0", "method": "exit" }));
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn exit_without_shutdown_is_not_a_clean_lifecycle() {
    let mut child = provider_command()
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    send(&mut stdin, &json!({ "jsonrpc": "2.0", "method": "exit" }));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            panic!("provider did not terminate on an early exit notification");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    assert!(!status.success());
}

#[test]
fn unanswered_host_callback_respects_the_exact_granted_timeout() {
    let (mut child, mut stdin, mut stdout) = start_provider(true);
    let baseline = json!({ "rev": "git:tree:timeout" });
    initialize_minimal_provider(&mut stdin, &mut stdout, &baseline, 20);
    let source = b"def ok():\n    pass\n";
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0", "id": "timeout", "method": "check/evaluate", "params": {
                "changeset": { "baseline": baseline, "changes": [{
                    "path": "a.py", "kind": "create", "after": blob_ref(source)
                }]},
                "scope": "changeset", "comparison": "introduced"
            }
        }),
    );
    assert_eq!(receive(&mut stdout)["method"], "workspace/listTree");
    let started = std::time::Instant::now();
    let timed_out = receive(&mut stdout);
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    assert_eq!(timed_out["id"], "timeout");
    assert_eq!(timed_out["error"]["code"], -32015);

    send(
        &mut stdin,
        &json!({ "jsonrpc": "2.0", "id": 9, "method": "shutdown" }),
    );
    let _ = receive(&mut stdout);
    send(&mut stdin, &json!({ "jsonrpc": "2.0", "method": "exit" }));
    drop(stdin);
    assert!(child.wait().unwrap().success());
}

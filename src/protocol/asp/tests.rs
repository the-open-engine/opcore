use super::*;
use crate::model::{CacheMetadata, Coverage, CoverageGap, ProviderMetadata, Timing};
use parking_lot::Mutex;
use std::collections::VecDeque;

struct MockHost(Mutex<VecDeque<Result<Value, RpcFailure>>>);

#[async_trait]
impl AspHost for MockHost {
    async fn request(
        &self,
        _method: &str,
        _params: Value,
        _timeout_ms: u64,
        _cancel: &CancelToken,
    ) -> Result<Value, RpcFailure> {
        self.0.lock().pop_front().expect("unexpected callback")
    }
}

fn session() -> AspSession {
    AspSession {
        baseline: json!({ "rev": "tree:test" }),
        wallclock_ms: 1_000,
        initialized_grant: json!({
            "read": ["**/*"],
            "write": false,
            "network": false,
            "resourceLimits": { "wallclockMs": 1_000 }
        }),
    }
}

async fn run_assessment(
    params: Value,
    session: AspSession,
    host: &dyn AspHost,
    profile: ProviderProfile,
) -> Value {
    let engine = Engine::new();
    evaluate_for(
        params,
        session,
        profile,
        EvaluationRuntime {
            host,
            engine: &engine,
            cancel: CancelToken::new(),
            project_root: None,
        },
    )
    .await
    .unwrap()
}

fn blob_id(bytes: &[u8]) -> String {
    format!("blob:sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn host_with_blob(entries: &[Value], id: &str, bytes: &[u8]) -> MockHost {
    MockHost(Mutex::new(VecDeque::from([
        Ok(json!({ "entries": entries, "truncated": false })),
        Ok(json!({
            "blobs": [{
                "id": id, "encoding": "utf-8", "bytes": String::from_utf8_lossy(bytes)
            }]
        })),
    ])))
}

async fn assert_fast_complete(params: Value, host: &MockHost, expected_blob: &str) {
    let assessment = run_assessment(params, session(), host, ProviderProfile::Fast).await;
    assert_eq!(assessment["status"], "complete", "{assessment}");
    assert_eq!(assessment["validAsOf"]["blobs"], json!([expected_blob]));
}

#[test]
fn workspace_coverage_requires_the_exact_full_read_grant() {
    let full = session();
    assert!(has_full_workspace_read(&full));

    let mut narrowed = full;
    narrowed.initialized_grant["read"] = json!(["src/**"]);
    assert!(!has_full_workspace_read(&narrowed));
    narrowed.initialized_grant["read"] = json!([]);
    assert!(!has_full_workspace_read(&narrowed));
}

#[test]
fn every_profile_has_one_exact_identity_and_scope_contract() {
    let request = json!({
        "protocolVersion": "asp/1.0",
        "host": { "name": "test", "version": "0.1.0" },
        "workspace": {
            "root": "/candidate",
            "baseline": { "rev": "tree:test" }
        }
    });
    for profile in ProviderProfile::ALL {
        let (result, baseline) = initialize_for(&request, profile).unwrap();
        assert_eq!(result["serverInfo"]["name"], profile.provider_id());
        assert_eq!(
            result["capabilities"]["check"]["diagnosticSources"],
            json!([profile.provider_id()])
        );
        assert_eq!(
            result["capabilities"]["check"]["scopes"],
            if profile == ProviderProfile::Fast {
                json!(["changeset", "workspace"])
            } else {
                json!(["workspace"])
            }
        );
        assert_eq!(baseline, json!({"rev": "tree:test"}));
    }
}

#[tokio::test]
async fn narrowed_workspace_grant_returns_unsupported_without_callbacks() {
    let mut narrowed = session();
    narrowed.initialized_grant["read"] = json!(["src/**"]);
    let params = json!({
        "changeset": { "baseline": { "rev": "tree:test" }, "changes": [] },
        "scope": "workspace",
        "comparison": "all"
    });
    let host = MockHost(Mutex::new(VecDeque::new()));
    let assessment = run_assessment(params, narrowed, &host, ProviderProfile::Fast).await;

    assert_eq!(assessment["status"], "unsupported");
    assert_eq!(assessment["coverage"]["exhaustive"], false);
}

fn create_params(after: &str) -> Value {
    json!({
        "changeset": { "baseline": { "rev": "tree:test" }, "changes": [{
            "path": "a.py", "kind": "create", "after": after
        }]},
        "scope": "changeset", "comparison": "introduced"
    })
}

fn normalized_changeset_params() -> NormalizedParams {
    NormalizedParams {
        scope: Scope::Changeset,
        scope_json: json!("changeset"),
        comparison: Comparison::Introduced,
        changeset: ChangeSet {
            baseline: Baseline {
                rev: "tree:test".into(),
                dirty: None,
                stamped_at: None,
            },
            changes: Vec::new(),
        },
        changeset_digest: "sha256:test".into(),
        requested_sources: vec![PROVIDER_ID.into()],
        requested_rules: vec![CORE_RULE.into()],
        configuration: configuration::resolve(None, ProviderProfile::Fast).unwrap(),
    }
}

#[test]
fn provider_configuration_rejects_invalid_values_and_canonicalizes_defaults() {
    let defaults = configuration_digest(None, ProviderProfile::Fast).unwrap();
    for value in [json!({}), json!({"verify": {}})] {
        assert_eq!(
            configuration_digest(Some(&value), ProviderProfile::Fast).unwrap(),
            defaults
        );
    }
    for value in [
        Value::Null,
        json!([]),
        json!({"unknown": true}),
        json!({"verify": null}),
        json!({"verify": {"maxParameter": 1}}),
        json!({"verify": {"maxParameters": -1}}),
        json!({"verify": {"maxNesting": 100_000}}),
    ] {
        let mut params = create_params("blob:sha256:00");
        params["configuration"] = value;
        assert!(normalize_params(params, &session()).is_err());
    }
    for profile in ProviderProfile::ALL
        .into_iter()
        .filter(|profile| profile.is_native())
    {
        assert_eq!(
            configuration_digest(None, profile).unwrap(),
            configuration_digest(Some(&json!({})), profile).unwrap()
        );
        assert!(configuration_digest(Some(&json!({"verify": {}})), profile).is_err());
    }
}

#[tokio::test]
async fn fast_configuration_changes_findings_and_binds_every_assessment_status() {
    let bytes = b"def example(a, b, c):\n    return a + b + c\n";
    let blob = blob_id(bytes);
    let request = create_params(&blob);
    let defaults = run_assessment(
        request.clone(),
        session(),
        &host_with_blob(&[], &blob, bytes),
        ProviderProfile::Fast,
    )
    .await;
    assert_eq!(defaults["diagnostics"], json!([]));
    let mut strict = request;
    strict["configuration"] = json!({"verify": {"maxParameters": 2}});
    let expected =
        configuration_digest(strict.get("configuration"), ProviderProfile::Fast).unwrap();
    let assessment = run_assessment(
        strict.clone(),
        session(),
        &host_with_blob(&[], &blob, bytes),
        ProviderProfile::Fast,
    )
    .await;
    assert_eq!(assessment["diagnostics"].as_array().unwrap().len(), 1);
    assert_eq!(assessment["provider"]["configDigest"], expected);
    assert_ne!(
        assessment["provider"]["configDigest"],
        defaults["provider"]["configDigest"]
    );

    strict["comparison"] = json!("resolved");
    let unavailable = run_assessment(
        strict,
        session(),
        &MockHost(Mutex::new(VecDeque::new())),
        ProviderProfile::Fast,
    )
    .await;
    assert_eq!(unavailable["status"], "unsupported");
    assert_eq!(unavailable["provider"]["configDigest"], expected);
}

#[test]
fn assessment_status_is_authoritative_for_incomplete_asp_coverage() {
    let assessment = Assessment {
        status: AssessmentStatus::Incomplete,
        diagnostics: Vec::new(),
        coverage: Coverage::default(),
        valid_as_of: "test".into(),
        provider: ProviderMetadata::default(),
        timing: Timing::default(),
        cache: CacheMetadata::default(),
    };
    let params = normalized_changeset_params();

    let coverage = AspCoverage::new(&assessment, &params);

    assert!(coverage.is_incomplete());
    assert!(!coverage.is_complete());
    assert_eq!(coverage.status(&assessment), "incomplete");
    assert!(coverage.covered_rules().is_empty());
}

#[test]
fn local_not_checked_maps_to_valid_fail_closed_asp_coverage() {
    let assessment = Assessment {
        status: AssessmentStatus::NotChecked,
        diagnostics: Vec::new(),
        coverage: Coverage {
            files_considered: 0,
            files_covered: 0,
            gaps: vec![CoverageGap {
                path: RepoPath::request_marker(),
                status: CoverageStatus::NotChecked,
                language: None,
                reason: Some("no supported source changes were selected".into()),
            }],
        },
        valid_as_of: "test".into(),
        provider: ProviderMetadata::default(),
        timing: Timing::default(),
        cache: CacheMetadata::default(),
    };
    let params = normalized_changeset_params();
    let converted = to_asp_assessment(
        assessment,
        &params,
        &[],
        &json!({ "rev": "tree:test" }),
        &session().initialized_grant,
    );

    assert_eq!(converted["status"], "unsupported");
    assert_eq!(
        converted["coverage"]["unsupported"][0]["reason"],
        "unsupported"
    );
    assert!(
        converted["coverage"]["unsupported"][0]["detail"]
            .as_str()
            .unwrap()
            .contains("no supported source changes")
    );
}

#[test]
fn change_validation_rejects_conflicting_fields() {
    let baseline = Baseline {
        rev: "tree:a".into(),
        dirty: None,
        stamped_at: None,
    };
    let invalid = ChangeSet {
        baseline,
        changes: vec![Change {
            path: RepoPath::from_protocol("a.py").unwrap(),
            kind: ChangeKind::Create,
            from: None,
            before: Some("blob:sha256:aa".into()),
            after: Some("blob:sha256:bb".into()),
        }],
    };
    assert!(validate_changeset(&invalid).is_err());
}

#[test]
fn baseline_timestamps_require_real_rfc3339_date_times() {
    for valid in ["2026-09-04T12:34:56Z", "2024-02-29t23:59:60.123+05:30"] {
        assert!(is_rfc3339_timestamp(valid), "expected valid: {valid}");
    }
    for invalid in [
        "not-a-date",
        "2025-02-29T00:00:00Z",
        "2026-09-04T24:00:00Z",
        "2026-09-04T12:34:56",
        "2026-09-04T12:34:56.+00:00",
    ] {
        assert!(
            !is_rfc3339_timestamp(invalid),
            "expected invalid: {invalid}"
        );
    }

    let changeset = ChangeSet {
        baseline: Baseline {
            rev: "tree:a".into(),
            dirty: None,
            stamped_at: Some("not-a-date".into()),
        },
        changes: Vec::new(),
    };
    assert!(validate_changeset(&changeset).is_err());

    let mut request = create_params("blob:sha256:00");
    request["changeset"]["baseline"]["dirty"] = Value::Null;
    assert!(normalize_params(request, &session()).is_err());

    let initialize = json!({
        "protocolVersion": "asp/1.0",
        "host": { "name": "test", "version": "0.1.0" },
        "workspace": {
            "root": "/candidate",
            "baseline": { "rev": "tree:test", "stampedAt": null }
        }
    });
    assert!(initialize_for(&initialize, ProviderProfile::Fast).is_err());
}

#[test]
fn optional_changeset_fields_reject_explicit_null() {
    for field in ["from", "before", "after"] {
        let mut request = create_params("blob:sha256:00");
        request["changeset"]["changes"][0][field] = Value::Null;
        assert!(normalize_params(request, &session()).is_err(), "{field}");
    }
}

#[test]
fn accepts_ignored_canonical_prior_results_but_rejects_private_shapes() {
    let session = session();
    let valid_as_of = json!({
        "baseline": { "rev": "tree:test" },
        "changesetDigest": "sha256:prior",
        "blobs": []
    });
    let prior = json!({
        "changeset": { "baseline": { "rev": "tree:test" }, "changes": [] },
        "scope": "changeset",
        "comparison": "introduced",
        "priorDiagnostics": [{
            "diagnostic": {
                "code": "prior/rule", "severity": "warning", "source": "prior",
                "message": "prior finding", "location": { "path": "a.py" },
                "fingerprint": "sha256:prior",
                "fix": { "editRef": "prior/edit", "args": { "path": "a.py" } }
            },
            "validAsOf": valid_as_of
        }],
        "priorAssessments": [{
            "assessmentId": "prior-assessment",
            "validAsOf": valid_as_of,
            "provider": {
                "id": "prior", "version": "0.1.0", "configDigest": "sha256:config",
                "capabilityVersion": "check/1.0", "capabilityFamily": "check"
            }
        }]
    });
    assert!(normalize_params(prior, &session).is_ok());

    for malformed in [
        json!({ "priorDiagnostics": [null] }),
        json!({
            "priorDiagnostics": [{
                "diagnostic": {
                    "code": "prior/rule", "severity": "warning", "source": "prior",
                    "message": "prior finding", "location": { "path": "a.py" },
                    "fingerprint": "sha256:prior", "help": null
                },
                "validAsOf": valid_as_of
            }]
        }),
        json!({
            "priorAssessments": [{
                "assessmentId": "prior-assessment", "validAsOf": valid_as_of,
                "provider": {
                    "id": "prior", "version": "0.1.0", "configDigest": "sha256:config",
                    "capabilityVersion": "check/1.0"
                },
                "digest": null
            }]
        }),
    ] {
        let mut params = json!({
            "changeset": { "baseline": { "rev": "tree:test" }, "changes": [] },
            "scope": "changeset", "comparison": "introduced"
        });
        params
            .as_object_mut()
            .unwrap()
            .extend(malformed.as_object().unwrap().clone());
        assert!(normalize_params(params, &session).is_err());
    }

    let compatibility = json!({
        "callSite": "gate",
        "baseline": { "rev": "tree:test" },
        "changeset": { "baseline": { "rev": "tree:test" }, "changes": [] },
        "changesetDigest": "sha256:00",
        "comparison": "introduced",
        "requiredCheck": "core-required-check"
    });
    assert!(normalize_params(compatibility, &session).is_err());
}

#[test]
fn request_source_and_rule_filters_are_unique_and_nonempty() {
    let session = session();
    for (field, value) in [
        ("diagnosticSources", json!(["opcore", "opcore"])),
        ("rules", json!([""])),
    ] {
        let mut params = create_params("blob:sha256:00");
        params[field] = value;
        assert!(normalize_params(params, &session).is_err());
    }
}

#[test]
fn digest_matches_sorted_object_key_algorithm() {
    let left = json!({"z": [2, 1], "a": {"y": 2, "x": 1}});
    let right = json!({"a": {"x": 1, "y": 2}, "z": [2, 1]});
    assert_eq!(digest_json(&left).unwrap(), digest_json(&right).unwrap());
}

#[tokio::test]
async fn reports_truncated_listing_and_rejects_blob_mismatch() {
    let truncated = MockHost(Mutex::new(VecDeque::from([Ok(json!({
        "entries": [], "truncated": true
    }))])));
    let assessment = evaluate(
        create_params("blob:sha256:00"),
        session(),
        &truncated,
        &Engine::new(),
        CancelToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(assessment["status"], "incomplete");
    assert_eq!(assessment["coverage"]["truncated"], true);
    assert_eq!(assessment["validAsOf"]["blobs"], json!([]));

    let expected = format!("blob:sha256:{}", hex::encode(Sha256::digest(b"expected")));
    let mismatch = MockHost(Mutex::new(VecDeque::from([
        Ok(json!({ "entries": [], "truncated": false })),
        Ok(json!({ "blobs": [{ "id": expected, "encoding": "utf-8", "bytes": "wrong" }] })),
    ])));
    let result = evaluate(
        create_params(&expected),
        session(),
        &mismatch,
        &Engine::new(),
        CancelToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(result.code, -32014);
    assert_eq!(result.fail_class, "contract");
    assert!(result.detail.contains("hash mismatch"));
}

#[tokio::test]
async fn every_recognized_unsupported_language_is_reported_without_blob_reads() {
    let after = "blob:sha256:00";
    for path in ["src/Main.java", "src/main.zig"] {
        for scope in [json!("changeset"), json!("workspace")] {
            let host = MockHost(Mutex::new(VecDeque::from([Ok(json!({
                "entries": [], "truncated": false
            }))])));
            let params = json!({
                "changeset": { "baseline": { "rev": "tree:test" }, "changes": [{
                    "path": path, "kind": "create", "after": after
                }]},
                "scope": scope,
                "comparison": "introduced"
            });
            let assessment = run_assessment(params, session(), &host, ProviderProfile::Fast).await;
            assert_eq!(assessment["status"], "unsupported", "{path}: {assessment}");
            assert_eq!(assessment["validAsOf"]["blobs"], json!([]));
        }
    }
}

#[tokio::test]
async fn source_rename_requests_the_other_endpoint_for_preconditions() {
    let source = b"pub fn answer() -> u32 { 42 }\n";
    let blob = blob_id(source);
    let host = host_with_blob(
        &[json!({ "path": "src/main.txt", "blobId": blob, "kind": "file" })],
        &blob,
        source,
    );
    let params = json!({
        "changeset": { "baseline": { "rev": "tree:test" }, "changes": [{
            "path": "src/main.rs", "from": "src/main.txt", "kind": "rename",
            "before": blob, "after": blob
        }]},
        "scope": "changeset", "comparison": "introduced"
    });

    assert_fast_complete(params, &host, &blob).await;
}

#[tokio::test]
async fn path_scope_does_not_request_or_validate_unselected_changes() {
    let source = b"def selected():\n    return 1\n";
    let blob = blob_id(source);
    let host = host_with_blob(&[], &blob, source);
    let params = json!({
        "changeset": { "baseline": { "rev": "tree:test" }, "changes": [
            { "path": "selected.py", "kind": "create", "after": blob },
            {
                "path": "outside.py", "kind": "modify",
                "before": "blob:sha256:11", "after": "blob:sha256:22"
            }
        ]},
        "scope": { "paths": ["selected.py"] }, "comparison": "all"
    });

    assert_fast_complete(params, &host, &blob).await;
}

#[tokio::test]
async fn directory_entries_are_ignored_and_source_symlinks_are_unsupported() {
    let blob = "blob:sha256:00";
    let params = json!({
        "changeset": { "baseline": { "rev": "tree:test" }, "changes": [] },
        "scope": "workspace", "comparison": "all"
    });
    let directory = MockHost(Mutex::new(VecDeque::from([Ok(json!({
        "entries": [{ "path": "generated.py", "blobId": blob, "kind": "dir" }],
        "truncated": false
    }))])));
    let assessment =
        run_assessment(params.clone(), session(), &directory, ProviderProfile::Fast).await;
    assert_eq!(assessment["status"], "complete");
    assert_eq!(assessment["validAsOf"]["blobs"], json!([]));

    for profile in ProviderProfile::ALL {
        let symlink = MockHost(Mutex::new(VecDeque::from([Ok(json!({
            "entries": [{ "path": "linked.py", "blobId": blob, "kind": "symlink" }],
            "truncated": false
        }))])));
        let assessment = run_assessment(params.clone(), session(), &symlink, profile).await;
        assert_eq!(assessment["status"], "unsupported");
        assert_eq!(assessment["validAsOf"]["blobs"], json!([]));
    }
}

#[tokio::test]
async fn rejects_protocol_path_escape_before_callbacks() {
    let host = MockHost(Mutex::new(VecDeque::new()));
    let params = json!({
        "changeset": { "baseline": { "rev": "tree:test" }, "changes": [{
            "path": "../a.py", "kind": "create", "after": "blob:sha256:00"
        }]},
        "scope": "changeset", "comparison": "introduced"
    });
    let result = evaluate(params, session(), &host, &Engine::new(), CancelToken::new())
        .await
        .unwrap_err();
    assert_eq!(result.code, -32013);
}

#[tokio::test]
async fn valid_but_unadvertised_comparison_returns_unsupported_assessment() {
    let host = MockHost(Mutex::new(VecDeque::new()));
    let params = json!({
        "changeset": { "baseline": { "rev": "tree:test" }, "changes": [] },
        "scope": "workspace",
        "comparison": "resolved"
    });

    let assessment = run_assessment(params, session(), &host, ProviderProfile::Fast).await;

    assert_eq!(assessment["status"], "unsupported");
    assert_eq!(
        assessment["coverage"]["requested"]["comparison"],
        "resolved"
    );
    assert_eq!(assessment["validAsOf"]["blobs"], json!([]));
}

#[tokio::test]
async fn callback_refusal_preserves_typed_policy_failure() {
    let host = MockHost(Mutex::new(VecDeque::from([Err(RpcFailure::policy(
        "host refused listTree",
    ))])));
    let result = evaluate(
        create_params("blob:sha256:00"),
        session(),
        &host,
        &Engine::new(),
        CancelToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(result.code, -32012);
    assert_eq!(result.fail_class, "policy");
}

#[test]
fn initialized_does_not_expand_host_wallclock_grants() {
    let baseline = json!({ "rev": "tree:test" });
    let granted = |wallclock_ms| {
        json!({
            "grantedPermissions": {
                "read": ["**/*"],
                "resourceLimits": { "wallclockMs": wallclock_ms }
            },
            "baseline": baseline
        })
    };
    assert_eq!(initialized(&granted(1), &baseline).unwrap().wallclock_ms, 1);
    assert_eq!(
        initialized(&granted(400_000), &baseline)
            .unwrap()
            .wallclock_ms,
        300_000
    );
    assert_eq!(
        initialized(&granted(0), &baseline).unwrap_err().code,
        -32012
    );
}

#[test]
fn initialized_refuses_write_or_network_authority() {
    let baseline = json!({ "rev": "tree:test" });
    for permission in ["write", "network"] {
        let mut permissions = serde_json::Map::from_iter([
            ("read".into(), json!(["**/*"])),
            ("resourceLimits".into(), json!({ "wallclockMs": 1_000 })),
        ]);
        permissions.insert(permission.into(), json!(true));
        let params = json!({
            "grantedPermissions": permissions,
            "baseline": baseline
        });
        let error = initialized(&params, &baseline).unwrap_err();
        assert_eq!(error.fail_class, "policy");
    }
}

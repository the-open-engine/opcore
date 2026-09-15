use super::{
    Assessment, AssessmentStatus, CAPABILITY_VERSION, CORE_RULE, Comparison, CoverageStatus,
    NormalizedParams, PROVIDER_ID, Value, build_digest, json,
};

pub(super) fn to_asp_assessment(
    assessment: Assessment,
    params: &NormalizedParams,
    read_ids: &[String],
    baseline: &Value,
    initialized_grant: &Value,
) -> Value {
    let coverage = AspCoverage::new(&assessment, params);
    let status = coverage.status(&assessment);
    let cache_status = cache_status(&assessment);
    let diagnostics = asp_diagnostics(assessment.diagnostics, params, &coverage);
    let config_digest = &params.configuration.digest;
    let requested = coverage_part(params, &params.requested_sources, &params.requested_rules);
    let covered_sources = coverage.covered_sources();
    let covered_rules = coverage.covered_rules();
    let covered = coverage_part(params, &covered_sources, &covered_rules);
    json!({
        "status": status,
        "diagnostics": diagnostics,
        "evidence": [{
            "kind": "metric",
            "message": "Opcore in-process parser verification; evidence does not grant host authority.",
            "data": {
                "filesRead": assessment.timing.files_read,
                "filesParsed": assessment.timing.files_parsed,
                "cacheHits": assessment.cache.hits,
                "cacheMisses": assessment.cache.misses,
                "initializedGrant": initialized_grant
            }
        }],
        "coverage": {
            "requested": requested,
            "covered": covered,
            "degraded": coverage.degraded,
            "unsupported": coverage.unsupported,
            "exhaustive": coverage.is_complete(),
            "truncated": coverage.is_incomplete()
        },
        "validAsOf": {
            "baseline": baseline,
            "changesetDigest": params.changeset_digest,
            "blobs": read_ids
        },
        "provider": {
            "id": PROVIDER_ID,
            "version": env!("CARGO_PKG_VERSION"),
            "configDigest": config_digest,
            "capabilityVersion": CAPABILITY_VERSION,
            "buildDigest": build_digest(),
            "capabilityFamily": "check"
        },
        "timing": { "elapsedMs": assessment.timing.duration_ms },
        "cache": { "status": cache_status }
    })
}

pub(super) struct AspCoverage {
    unsupported: Vec<Value>,
    degraded: Vec<Value>,
    assessment_status: AssessmentStatus,
    request_support: RequestSupport,
    requested_sources: Vec<String>,
    requested_rules: Vec<String>,
}

#[derive(Clone, Copy)]
struct RequestSupport {
    sources: bool,
    rules: bool,
}

impl AspCoverage {
    pub(super) fn new(assessment: &Assessment, params: &NormalizedParams) -> Self {
        let incomplete = assessment.status == AssessmentStatus::Incomplete;
        let request_support = RequestSupport {
            sources: params
                .requested_sources
                .iter()
                .all(|source| source == PROVIDER_ID),
            rules: params.requested_rules.iter().all(|rule| rule == CORE_RULE),
        };
        let mut unsupported = unsupported_gaps(assessment);
        append_request_unsupported(&mut unsupported, request_support);
        let mut degraded = unsupported.clone();
        if incomplete {
            degraded.push(coverage_notice(
                "incomplete",
                "required file coverage was incomplete",
            ));
        }
        Self {
            unsupported,
            degraded,
            assessment_status: assessment.status,
            request_support,
            requested_sources: params.requested_sources.clone(),
            requested_rules: params.requested_rules.clone(),
        }
    }

    pub(super) fn status(&self, assessment: &Assessment) -> &'static str {
        match assessment.status {
            AssessmentStatus::Cancelled => "cancelled",
            AssessmentStatus::Error => "error",
            AssessmentStatus::NotChecked => "unsupported",
            _ if self.assessment_status == AssessmentStatus::Incomplete => "incomplete",
            _ if !self.unsupported.is_empty() => "unsupported",
            _ => "complete",
        }
    }

    pub(super) fn covered_rules(&self) -> Vec<String> {
        if self.is_complete() {
            self.requested_rules.clone()
        } else {
            Vec::new()
        }
    }

    fn covered_sources(&self) -> Vec<String> {
        if self.is_complete() {
            self.requested_sources.clone()
        } else {
            Vec::new()
        }
    }

    pub(super) fn is_complete(&self) -> bool {
        self.unsupported.is_empty()
            && !matches!(
                self.assessment_status,
                AssessmentStatus::NotChecked
                    | AssessmentStatus::Incomplete
                    | AssessmentStatus::Error
                    | AssessmentStatus::Cancelled
            )
    }

    pub(super) fn is_incomplete(&self) -> bool {
        self.assessment_status == AssessmentStatus::Incomplete
    }
}

fn unsupported_gaps(assessment: &Assessment) -> Vec<Value> {
    let mut unsupported = Vec::new();
    for item in assessment.coverage.gaps.iter().filter(|item| {
        matches!(
            item.status,
            CoverageStatus::Unsupported | CoverageStatus::NotChecked
        )
    }) {
        unsupported.push(json!({
            "source": PROVIDER_ID,
            // ASP v1 has no `not_checked` degradation reason. Keep the local distinction in the
            // detail while mapping the defensive provider path to a valid fail-closed reason.
            "reason": "unsupported",
            "detail": format!(
                "{}: {}",
                item.path,
                item.reason.as_deref().unwrap_or("unsupported source")
            ),
            "capability": "check"
        }));
    }
    unsupported
}

fn append_request_unsupported(unsupported: &mut Vec<Value>, support: RequestSupport) {
    if !support.sources {
        unsupported.push(coverage_notice(
            "unsupported",
            "requested diagnostic source is not owned by opcore",
        ));
    }
    if !support.rules {
        unsupported.push(coverage_notice(
            "unsupported",
            "requested rule is not owned by Opcore Verify",
        ));
    }
}

fn coverage_notice(reason: &str, detail: &str) -> Value {
    json!({
        "source": PROVIDER_ID,
        "reason": reason,
        "detail": detail,
        "capability": "check"
    })
}

fn asp_diagnostics(
    diagnostics: Vec<crate::model::Diagnostic>,
    params: &NormalizedParams,
    coverage: &AspCoverage,
) -> Vec<Value> {
    if coverage.request_support.rules && coverage.request_support.sources {
        diagnostics
            .into_iter()
            .map(|diagnostic| asp_diagnostic(&diagnostic, params.comparison))
            .collect()
    } else {
        Vec::new()
    }
}

fn asp_diagnostic(diagnostic: &crate::model::Diagnostic, comparison: Comparison) -> Value {
    let range = diagnostic.range.map(|range| {
        json!({
            "start": {
                "line": range.start.line.saturating_sub(1),
                "char": range.start.column.saturating_sub(1)
            },
            "end": {
                "line": range.end.line.saturating_sub(1),
                "char": range.end.column.saturating_sub(1)
            }
        })
    });
    let mut location = serde_json::Map::new();
    location.insert("path".into(), json!(diagnostic.path));
    if let Some(range) = range {
        location.insert("range".into(), range);
    }
    let mut value = json!({
        "code": format!("{PROVIDER_ID}/{}", diagnostic.rule_id),
        "severity": diagnostic.severity,
        "source": PROVIDER_ID,
        "message": diagnostic.message,
        "location": location,
        "fingerprint": format!("sha256:{}", diagnostic.fingerprint)
    });
    if comparison == Comparison::Introduced {
        value["introduced"] = json!(true);
    }
    value
}

fn coverage_part(params: &NormalizedParams, sources: &[String], rules: &[String]) -> Value {
    json!({
        "scope": params.scope_json,
        "diagnosticSources": sources,
        "rules": rules,
        "comparison": params.comparison
    })
}

fn cache_status(assessment: &Assessment) -> &'static str {
    if assessment.cache.state == "disabled" {
        "disabled"
    } else if assessment.cache.misses == 0 && assessment.cache.hits > 0 {
        "hit"
    } else {
        "miss"
    }
}

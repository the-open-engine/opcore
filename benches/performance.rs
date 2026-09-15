use std::{collections::BTreeSet, sync::Arc, time::Instant};

use opcore::api::test_support::{
    CancelToken, Comparison, Engine, EvaluationRequest, Language, RepoPath, RuleLimits, Scope,
    SourceFile, SourceSnapshot,
};
use serde_json::json;

fn source(index: usize) -> SourceFile {
    let path = RepoPath::from_protocol(&format!("src/file-{index}.ts")).expect("benchmark path");
    SourceFile::new(
        path,
        format!("// {index}\nexport function value_{index}(input) {{ return input + {index}; }}\n")
            .into_bytes(),
        Language::TypeScript,
        "typescript".into(),
    )
}

fn request(view: Arc<SourceSnapshot>, count: usize) -> EvaluationRequest {
    EvaluationRequest {
        before: None,
        after: view,
        scope: Scope::Changeset,
        comparison: Comparison::All,
        paths: (0..count)
            .map(|index| RepoPath::from_protocol(&format!("src/file-{index}.ts")).unwrap())
            .collect::<BTreeSet<_>>(),
        limits: RuleLimits::default(),
        valid_as_of: "benchmark".into(),
        public_fingerprint_comparison: false,
    }
}

fn p95(samples: &mut [f64]) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[(samples.len() * 95).div_ceil(100).saturating_sub(1)]
}

fn resident_memory_kib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status.lines().find_map(|line| {
        line.strip_prefix("VmRSS:")?
            .split_ascii_whitespace()
            .next()?
            .parse()
            .ok()
    })
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("benchmark runtime");
    let engine = Engine::new();
    let one = Arc::new(SourceSnapshot::new([source(0)]));
    let ten = Arc::new(SourceSnapshot::new((0..10).map(source)));

    runtime
        .block_on(engine.evaluate(request(Arc::clone(&one), 1), CancelToken::new()))
        .expect("warm one-file cache");
    runtime
        .block_on(engine.evaluate(request(Arc::clone(&ten), 10), CancelToken::new()))
        .expect("warm ten-file cache");

    let mut one_samples = Vec::with_capacity(100);
    let mut ten_samples = Vec::with_capacity(100);
    for _ in 0..100 {
        let started = Instant::now();
        let assessment = runtime
            .block_on(engine.evaluate(request(Arc::clone(&one), 1), CancelToken::new()))
            .expect("one-file evaluation");
        std::hint::black_box(assessment);
        one_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

        let started = Instant::now();
        let assessment = runtime
            .block_on(engine.evaluate(request(Arc::clone(&ten), 10), CancelToken::new()))
            .expect("ten-file evaluation");
        std::hint::black_box(assessment);
        ten_samples.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    let one_p95 = p95(&mut one_samples);
    let ten_p95 = p95(&mut ten_samples);

    let throughput_engine = Engine::new();
    let thousand = Arc::new(SourceSnapshot::new((0..1_000).map(source)));
    let throughput_started = Instant::now();
    let throughput = runtime
        .block_on(throughput_engine.evaluate(request(thousand, 1_000), CancelToken::new()))
        .expect("thousand-file evaluation");
    let throughput_ms = throughput_started.elapsed().as_secs_f64() * 1_000.0;

    let report = json!({
        "schema": "opcore.performance.v1",
        "profile": "release",
        "environment": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "logicalCpus": std::thread::available_parallelism().map_or(1, usize::from),
            "rssKiB": resident_memory_kib(),
        },
        "warmEngine": {
            "iterations": 100,
            "oneFileP95Ms": one_p95,
            "tenFileP95Ms": ten_p95,
        },
        "coldEngineThroughput": {
            "files": 1_000,
            "durationMs": throughput_ms,
            "filesParsed": throughput.timing.files_parsed,
        }
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}

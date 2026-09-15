use std::{
    collections::{HashMap, VecDeque},
    fmt::Write as _,
    hint::black_box,
    mem::size_of,
    time::Instant,
};

use oxc_allocator::Allocator;
use oxc_parser::{Parser, config::TokensParserConfig};
use oxc_span::SourceType;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const WINDOW_TOKENS: usize = 48;
const KGRAM_TOKENS: usize = 32;
const WINNOW_SPAN: usize = 17;
const WINDOW_BUDGET: usize = 200_000;
const ROLLING_ITERATIONS: usize = 15;
const SHA_ITERATIONS: usize = 5;
const BASE_ONE: u64 = 0x9e37_79b1_85eb_ca87;
const BASE_TWO: u64 = 0xc2b2_ae3d_27d4_eb4f;
const SEED_ONE: u64 = 0xa076_1d64_78bd_642f;
const SEED_TWO: u64 = 0xe703_7ed1_a0b4_28db;

#[derive(Clone, Copy)]
enum CorpusKind {
    Unique,
    Shared,
}

impl CorpusKind {
    const fn label(self) -> &'static str {
        match self {
            Self::Unique => "unique",
            Self::Shared => "duplicate-heavy",
        }
    }
}

#[derive(Clone, Copy)]
struct Scenario {
    files: usize,
    statements: usize,
    kind: CorpusKind,
}

#[derive(Default)]
struct TokenInterner {
    values: HashMap<String, u32>,
}

impl TokenInterner {
    fn intern(&mut self, text: &str, preceded_by_line_break: bool) -> u32 {
        let mut key = String::with_capacity(text.len().saturating_add(1));
        key.push(if preceded_by_line_break { 'L' } else { 'S' });
        key.push_str(text);
        if let Some(value) = self.values.get(&key) {
            return *value;
        }
        let value = u32::try_from(self.values.len()).expect("benchmark vocabulary fits in u32");
        self.values.insert(key, value);
        value
    }
}

struct TokenCorpus {
    files: Vec<Vec<u32>>,
    token_count: usize,
    vocabulary_size: usize,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct WindowRecord {
    hash_one: u64,
    hash_two: u64,
    file: u32,
    start: u32,
}

#[derive(Clone, Copy)]
struct IndexResult {
    possible_windows: usize,
    indexed_windows: usize,
    duplicate_classes: usize,
    duplicate_occurrences: usize,
    exact_token_comparisons: usize,
    hash_collision_groups: usize,
    truncated: bool,
}

struct TimingSummary {
    median_ms: f64,
    p95_ms: f64,
    result: IndexResult,
}

fn main() {
    assert_winnowing_guarantee_samples();
    let scenarios = [
        Scenario {
            files: 100,
            statements: 48,
            kind: CorpusKind::Unique,
        },
        Scenario {
            files: 320,
            statements: 48,
            kind: CorpusKind::Unique,
        },
        Scenario {
            files: 800,
            statements: 48,
            kind: CorpusKind::Unique,
        },
        Scenario {
            files: 800,
            statements: 48,
            kind: CorpusKind::Shared,
        },
        Scenario {
            files: 10_000,
            statements: 48,
            kind: CorpusKind::Unique,
        },
    ];
    let mut reports = Vec::with_capacity(scenarios.len());
    for scenario in scenarios {
        reports.push(run_scenario(scenario));
    }
    let logical_cpus = std::thread::available_parallelism().map_or(1, usize::from);
    let report = json!({
        "schema": "opcore.token-window-experiment.v1",
        "profile": "release",
        "environment": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "logicalCpus": logical_cpus,
        },
        "configuration": {
            "windowTokens": WINDOW_TOKENS,
            "kgramTokens": KGRAM_TOKENS,
            "winnowSpan": WINNOW_SPAN,
            "guaranteedMatchTokens": KGRAM_TOKENS + WINNOW_SPAN - 1,
            "windowBudget": WINDOW_BUDGET,
            "rollingIterations": ROLLING_ITERATIONS,
            "shaIterations": SHA_ITERATIONS,
            "recordBytes": size_of::<WindowRecord>(),
        },
        "scenarios": reports,
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}

fn assert_winnowing_guarantee_samples() {
    let shared_tokens =
        u32::try_from(KGRAM_TOKENS + WINNOW_SPAN - 1).expect("guarantee fits in u32");
    let shared = (10_000u32..10_000 + shared_tokens).collect::<Vec<_>>();
    for sample in 0..128u32 {
        let left_prefix = sample % 31;
        let right_prefix = sample.wrapping_mul(7) % 31;
        let left = (0..left_prefix)
            .map(|value| 100_000 + sample * 100 + value)
            .chain(shared.iter().copied())
            .chain((0..23).map(|value| 200_000 + sample * 100 + value))
            .collect::<Vec<_>>();
        let right = (0..right_prefix)
            .map(|value| 300_000 + sample * 100 + value)
            .chain(shared.iter().copied())
            .chain((0..19).map(|value| 400_000 + sample * 100 + value))
            .collect::<Vec<_>>();
        let corpus = TokenCorpus {
            token_count: left.len().saturating_add(right.len()),
            files: vec![left, right],
            vocabulary_size: 0,
        };
        assert!(
            winnowed_sha256_index(&corpus).duplicate_classes > 0,
            "a {sample}-offset exact match at the guarantee threshold must retain an anchor"
        );
    }
}

fn run_scenario(scenario: Scenario) -> Value {
    let lex_started = Instant::now();
    let corpus = token_corpus(scenario);
    let lex_ms = lex_started.elapsed().as_secs_f64() * 1_000.0;
    let rolling = measure(ROLLING_ITERATIONS, || rolling_index(&corpus));
    let winnowed = measure(ROLLING_ITERATIONS, || winnowed_sha256_index(&corpus));
    let sha256 = measure(SHA_ITERATIONS, || sha256_index(&corpus));
    let rolling_record_bytes = rolling
        .result
        .indexed_windows
        .saturating_mul(size_of::<WindowRecord>());
    let winnowed_record_bytes = winnowed
        .result
        .indexed_windows
        .saturating_mul(size_of::<WindowRecord>());
    json!({
        "name": format!("{}-{}-files", scenario.kind.label(), scenario.files),
        "files": scenario.files,
        "statementsPerFile": scenario.statements,
        "tokens": corpus.token_count,
        "vocabulary": corpus.vocabulary_size,
        "lexAndInternMs": lex_ms,
        "rolling": timing_json(&rolling),
        "winnowedSha256": timing_json(&winnowed),
        "sha256PerWindow": timing_json(&sha256),
        "incrementalMemory": {
            "rollingRecordBytes": rolling_record_bytes,
            "rollingBeforeAfterRecordBytes": rolling_record_bytes.saturating_mul(2),
            "winnowedRecordBytes": winnowed_record_bytes,
            "winnowedBeforeAfterRecordBytes": winnowed_record_bytes.saturating_mul(2),
            "tokenIdBytes": corpus.token_count.saturating_mul(size_of::<u32>()),
        }
    })
}

fn timing_json(timing: &TimingSummary) -> Value {
    let result = timing.result;
    json!({
        "medianMs": timing.median_ms,
        "p95Ms": timing.p95_ms,
        "possibleWindows": result.possible_windows,
        "indexedWindows": result.indexed_windows,
        "duplicateClasses": result.duplicate_classes,
        "duplicateOccurrences": result.duplicate_occurrences,
        "exactTokenComparisons": result.exact_token_comparisons,
        "hashCollisionGroups": result.hash_collision_groups,
        "truncated": result.truncated,
    })
}

fn measure(iterations: usize, mut operation: impl FnMut() -> IndexResult) -> TimingSummary {
    black_box(operation());
    let mut samples = Vec::with_capacity(iterations);
    let mut result = None;
    for _ in 0..iterations {
        let started = Instant::now();
        result = Some(black_box(operation()));
        samples.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    samples.sort_by(f64::total_cmp);
    let median_ms = samples[samples.len() / 2];
    let p95_index = (samples.len() * 95).div_ceil(100).saturating_sub(1);
    TimingSummary {
        median_ms,
        p95_ms: samples[p95_index],
        result: result.expect("benchmark executes at least once"),
    }
}

fn token_corpus(scenario: Scenario) -> TokenCorpus {
    let source_type = SourceType::from_path("window-benchmark.ts").expect("TypeScript source type");
    let mut interner = TokenInterner::default();
    let mut files = Vec::with_capacity(scenario.files);
    let mut token_count = 0usize;
    for file in 0..scenario.files {
        let source = generated_source(file, scenario.statements, scenario.kind);
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, &source, source_type)
            .with_config(TokensParserConfig)
            .parse();
        assert!(
            parsed.diagnostics.is_empty(),
            "generated benchmark source must parse"
        );
        let mut tokens = Vec::new();
        let mut previous_end = 0usize;
        for token in parsed.tokens.iter().filter(|token| !token.kind().is_eof()) {
            let start = token.start() as usize;
            let end = token.end() as usize;
            let line_break = source
                .as_bytes()
                .get(previous_end..start)
                .is_some_and(|gap| gap.contains(&b'\n'));
            let text = source.get(start..end).expect("token range");
            tokens.push(interner.intern(text, line_break));
            previous_end = end;
        }
        token_count = token_count.saturating_add(tokens.len());
        files.push(tokens);
    }
    TokenCorpus {
        files,
        token_count,
        vocabulary_size: interner.values.len(),
    }
}

fn generated_source(file: usize, statements: usize, kind: CorpusKind) -> String {
    let mut source =
        format!("export function value_{file}(input: number): number {{\n  let value = input;\n");
    for statement in 0..statements {
        match kind {
            CorpusKind::Unique => {
                writeln!(source, "  value = value + local_{file}_{statement};").unwrap();
            }
            CorpusKind::Shared => {
                writeln!(source, "  value = value + shared_{statement};").unwrap();
            }
        }
    }
    source.push_str("  return value;\n}\n");
    source
}

fn rolling_index(corpus: &TokenCorpus) -> IndexResult {
    let possible_windows = possible_windows(corpus);
    let mut records = Vec::with_capacity(possible_windows.min(WINDOW_BUDGET));
    for (file, tokens) in corpus.files.iter().enumerate() {
        for (start, (hash_one, hash_two)) in rolling_hashes(tokens, WINDOW_TOKENS)
            .into_iter()
            .enumerate()
        {
            push_record(&mut records, file, start, hash_one, hash_two);
            if records.len() == WINDOW_BUDGET {
                break;
            }
        }
        if records.len() >= WINDOW_BUDGET {
            break;
        }
    }
    finish_index(corpus, records, possible_windows, WINDOW_TOKENS)
}

fn sha256_index(corpus: &TokenCorpus) -> IndexResult {
    let possible_windows = possible_windows(corpus);
    let mut records = Vec::with_capacity(possible_windows.min(WINDOW_BUDGET));
    'files: for (file, tokens) in corpus.files.iter().enumerate() {
        if tokens.len() < WINDOW_TOKENS {
            continue;
        }
        for start in 0..=tokens.len().saturating_sub(WINDOW_TOKENS) {
            if records.len() >= WINDOW_BUDGET {
                break 'files;
            }
            let mut hasher = Sha256::new();
            for token in &tokens[start..start + WINDOW_TOKENS] {
                hasher.update(token.to_be_bytes());
            }
            let digest = hasher.finalize();
            let hash_one = u64::from_be_bytes(digest[..8].try_into().unwrap());
            let hash_two = u64::from_be_bytes(digest[8..16].try_into().unwrap());
            push_record(&mut records, file, start, hash_one, hash_two);
        }
    }
    finish_index(corpus, records, possible_windows, WINDOW_TOKENS)
}

fn winnowed_sha256_index(corpus: &TokenCorpus) -> IndexResult {
    let mut selected_kgrams = 0usize;
    let mut records = Vec::new();
    for (file, tokens) in corpus.files.iter().enumerate() {
        if tokens.len() < KGRAM_TOKENS + WINNOW_SPAN - 1 {
            continue;
        }
        let hashes = rolling_hashes(tokens, KGRAM_TOKENS);
        let mut minima = VecDeque::<usize>::new();
        let mut previous_selection = None;
        for index in 0..hashes.len() {
            while minima
                .back()
                .is_some_and(|prior| hashes[*prior] >= hashes[index])
            {
                minima.pop_back();
            }
            minima.push_back(index);
            while minima
                .front()
                .is_some_and(|prior| prior.saturating_add(WINNOW_SPAN) <= index)
            {
                minima.pop_front();
            }
            if index + 1 < WINNOW_SPAN {
                continue;
            }
            let selected = *minima.front().expect("winnow window has a minimum");
            if previous_selection == Some(selected) {
                continue;
            }
            previous_selection = Some(selected);
            selected_kgrams = selected_kgrams.saturating_add(1);
            if records.len() >= WINDOW_BUDGET {
                continue;
            }
            let mut digest_builder = Sha256::new();
            for token in &tokens[selected..selected + KGRAM_TOKENS] {
                digest_builder.update(token.to_be_bytes());
            }
            let digest = digest_builder.finalize();
            push_record(
                &mut records,
                file,
                selected,
                u64::from_be_bytes(digest[..8].try_into().unwrap()),
                u64::from_be_bytes(digest[8..16].try_into().unwrap()),
            );
        }
    }
    finish_index(corpus, records, selected_kgrams, KGRAM_TOKENS)
}

fn rolling_hashes(tokens: &[u32], window: usize) -> Vec<(u64, u64)> {
    let mut hashes = Vec::with_capacity(tokens.len().saturating_sub(window).saturating_add(1));
    if tokens.len() < window {
        return hashes;
    }
    let factor_one = wrapping_power(BASE_ONE, window);
    let factor_two = wrapping_power(BASE_TWO, window);
    let mut hash_one = 0u64;
    let mut hash_two = 0u64;
    for token in &tokens[..window] {
        hash_one = hash_one
            .wrapping_mul(BASE_ONE)
            .wrapping_add(mix(u64::from(*token) ^ SEED_ONE));
        hash_two = hash_two
            .wrapping_mul(BASE_TWO)
            .wrapping_add(mix(u64::from(*token) ^ SEED_TWO));
    }
    hashes.push((hash_one, hash_two));
    for start in 1..=tokens.len() - window {
        let previous = u64::from(tokens[start - 1]);
        let next = u64::from(tokens[start + window - 1]);
        hash_one = hash_one
            .wrapping_mul(BASE_ONE)
            .wrapping_add(mix(next ^ SEED_ONE))
            .wrapping_sub(mix(previous ^ SEED_ONE).wrapping_mul(factor_one));
        hash_two = hash_two
            .wrapping_mul(BASE_TWO)
            .wrapping_add(mix(next ^ SEED_TWO))
            .wrapping_sub(mix(previous ^ SEED_TWO).wrapping_mul(factor_two));
        hashes.push((hash_one, hash_two));
    }
    hashes
}

fn finish_index(
    corpus: &TokenCorpus,
    mut records: Vec<WindowRecord>,
    possible_windows: usize,
    window_tokens: usize,
) -> IndexResult {
    records.sort_unstable();
    let mut duplicate_classes = 0usize;
    let mut duplicate_occurrences = 0usize;
    let mut exact_token_comparisons = 0usize;
    let mut hash_collision_groups = 0usize;
    let mut index = 0usize;
    while index < records.len() {
        let mut end = index + 1;
        while end < records.len()
            && records[end].hash_one == records[index].hash_one
            && records[end].hash_two == records[index].hash_two
        {
            end += 1;
        }
        let group = &records[index..end];
        if group.len() > 1 && has_distinct_occurrences(group, window_tokens) {
            let representative = token_window(corpus, group[0], window_tokens);
            let mut exact = true;
            for occurrence in &group[1..] {
                exact_token_comparisons = exact_token_comparisons.saturating_add(1);
                if token_window(corpus, *occurrence, window_tokens) != representative {
                    exact = false;
                }
            }
            if exact {
                duplicate_classes = duplicate_classes.saturating_add(1);
                duplicate_occurrences = duplicate_occurrences.saturating_add(group.len());
            } else {
                hash_collision_groups = hash_collision_groups.saturating_add(1);
            }
        }
        index = end;
    }
    IndexResult {
        possible_windows,
        indexed_windows: records.len(),
        duplicate_classes,
        duplicate_occurrences,
        exact_token_comparisons,
        hash_collision_groups,
        truncated: records.len() < possible_windows,
    }
}

fn has_distinct_occurrences(group: &[WindowRecord], window_tokens: usize) -> bool {
    let first = group[0];
    group[1..].iter().any(|occurrence| {
        occurrence.file != first.file
            || occurrence.start.abs_diff(first.start)
                >= u32::try_from(window_tokens).expect("window fits in u32")
    })
}

fn token_window(corpus: &TokenCorpus, record: WindowRecord, window_tokens: usize) -> &[u32] {
    let file = &corpus.files[record.file as usize];
    let start = record.start as usize;
    &file[start..start + window_tokens]
}

fn possible_windows(corpus: &TokenCorpus) -> usize {
    corpus.files.iter().fold(0usize, |count, tokens| {
        count.saturating_add(
            tokens
                .len()
                .saturating_sub(WINDOW_TOKENS)
                .saturating_add(usize::from(tokens.len() >= WINDOW_TOKENS)),
        )
    })
}

fn push_record(
    records: &mut Vec<WindowRecord>,
    file: usize,
    start: usize,
    hash_one: u64,
    hash_two: u64,
) {
    if records.len() >= WINDOW_BUDGET {
        return;
    }
    records.push(WindowRecord {
        hash_one,
        hash_two,
        file: u32::try_from(file).expect("benchmark file count fits in u32"),
        start: u32::try_from(start).expect("benchmark token offset fits in u32"),
    });
}

fn wrapping_power(base: u64, exponent: usize) -> u64 {
    (0..exponent).fold(1u64, |product, _| product.wrapping_mul(base))
}

fn mix(value: u64) -> u64 {
    let first = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    let second = (first ^ (first >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    second ^ (second >> 31)
}

#![cfg(unix)]

use std::{
    collections::BTreeSet,
    ffi::OsStr,
    fmt::Write as _,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use opcore::api::test_support::{
    CancelToken, GoModuleViews, Language, RepoPath, SenseEngine, SenseOptions, SenseRequest,
    SenseStatus, SourceFile, SourceSnapshot,
};

const LARGE_FILES: usize = 10_000;
const SMALL_FILES: usize = 1_000;
const CHANGED_FILES: usize = 1_000;
const WARM_SAMPLE_COUNT: usize = 3;
const PROFILE_TIMEOUT: Duration = Duration::from_secs(10);

fn git(repo: &Path, args: &[&str]) {
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

fn source(index: usize, files: usize, changed: bool) -> String {
    let dependency = if changed {
        String::new()
    } else if index + 1 < files {
        format!("import './f{:05}';\n", index + 1)
    } else {
        String::new()
    };
    let changed = if changed { "// changed\n" } else { "" };
    let padding = if index == 9_000 {
        format!("// {}\n", "x".repeat(300))
    } else {
        String::new()
    };
    format!("{dependency}{changed}{padding}export const value_{index} = {index};\n")
}

fn cycle_source(index: usize) -> String {
    format!("import './f00000';\nexport const value_{index} = {index};\n")
}

fn initialize_fixture(repo: &Path, files: usize) {
    fs::create_dir_all(repo.join("src")).unwrap();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.name", "Test"]);
    git(repo, &["config", "user.email", "test@example.com"]);
    for index in 0..files {
        fs::write(
            repo.join(format!("src/f{index:05}.ts")),
            source(index, files, false),
        )
        .unwrap();
    }
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "large fixture"]);
}

struct ProfiledOutput {
    output: Output,
    wall_us: u64,
    peak_rss_kib: u64,
}

fn run_sense(binary: &Path, repo: &Path, cache: &Path) -> ProfiledOutput {
    run_profiled(
        binary,
        &[
            OsStr::new("sense"),
            OsStr::new("--repo"),
            repo.as_os_str(),
            OsStr::new("--json"),
            OsStr::new("--advisory"),
            OsStr::new("--allow-partial"),
        ],
        cache,
    )
}

fn run_empty_changed_verify(binary: &Path, repo: &Path, cache: &Path) -> ProfiledOutput {
    run_profiled(
        binary,
        &[
            OsStr::new("check"),
            OsStr::new("--repo"),
            repo.as_os_str(),
            OsStr::new("--changed"),
            OsStr::new("--json"),
            OsStr::new("--advisory"),
        ],
        cache,
    )
}

fn run_profiled(binary: &Path, args: &[&OsStr], cache: &Path) -> ProfiledOutput {
    run_profiled_with_timeout(binary, args, cache, PROFILE_TIMEOUT)
}

fn run_profiled_with_timeout(
    binary: &Path,
    args: &[&OsStr],
    cache: &Path,
    timeout: Duration,
) -> ProfiledOutput {
    let started = Instant::now();
    let executable = fs::canonicalize(binary).unwrap();
    let mut child = Command::new(binary)
        .args(args)
        .env("XDG_CACHE_HOME", cache)
        .env("LC_ALL", "C")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = drain(child.stdout.take().unwrap());
    let stderr = drain(child.stderr.take().unwrap());
    let mut peak_rss_kib = 0;
    let mut exec_confirmed = false;
    let status = loop {
        exec_confirmed |= process_executable(child.id()).is_some_and(|path| path == executable);
        if exec_confirmed {
            peak_rss_kib = peak_rss_kib.max(process_peak_rss_kib(child.id()).unwrap_or(0));
        }
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let stdout = stdout.join().unwrap();
            let stderr = stderr.join().unwrap();
            panic!(
                "profiled command exceeded {timeout:?}; stdout={}; stderr={}",
                bounded_text(&stdout),
                bounded_text(&stderr)
            );
        }
        thread::sleep(Duration::from_micros(200));
    };
    ProfiledOutput {
        output: Output {
            status,
            stdout: stdout.join().unwrap(),
            stderr: stderr.join().unwrap(),
        },
        wall_us: elapsed_us(started),
        peak_rss_kib,
    }
}

fn bounded_text(bytes: &[u8]) -> String {
    const LIMIT: usize = 4_096;
    String::from_utf8_lossy(&bytes[..bytes.len().min(LIMIT)]).into_owned()
}

fn drain(mut pipe: impl Read + Send + 'static) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        pipe.read_to_end(&mut bytes).unwrap();
        bytes
    })
}

fn process_executable(pid: u32) -> Option<PathBuf> {
    fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(target_os = "linux")]
fn process_peak_rss_kib(pid: u32) -> Option<u64> {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    status.lines().find_map(|line| {
        line.strip_prefix("VmHWM:")?
            .split_ascii_whitespace()
            .next()?
            .parse()
            .ok()
    })
}

#[cfg(not(target_os = "linux"))]
fn process_peak_rss_kib(_pid: u32) -> Option<u64> {
    None
}

fn elapsed_us(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX)
}

fn report(profile: &ProfiledOutput) -> Value {
    serde_json::from_slice(&profile.output.stdout).unwrap_or_else(|error| {
        panic!(
            "invalid JSON: {error}\nstdout={}\nstderr={}",
            String::from_utf8_lossy(&profile.output.stdout),
            String::from_utf8_lossy(&profile.output.stderr)
        )
    })
}

fn measurement(profile: &ProfiledOutput) -> Value {
    let report = report(profile);
    json!({
        "wallUs": profile.wall_us,
        "peakRssKiB": profile.peak_rss_kib,
        "status": report["status"],
        "timing": report["timing"],
        "cache": report["cache"],
        "runtimeEdges": report["after"]["runtimeEdges"],
        "observations": {
            "dependencyDeltas": report["observations"]["dependencyDeltas"].as_array().unwrap().len(),
            "impact": report["observations"]["impact"].as_array().unwrap().len(),
            "impactTruncated": report["observations"]["impactTruncated"],
            "truncated": report["observations"]["truncated"],
        }
    })
}

fn verify_measurement(profile: &ProfiledOutput) -> Value {
    let report = report(profile);
    json!({
        "wallUs": profile.wall_us,
        "peakRssKiB": profile.peak_rss_kib,
        "status": report["status"],
        "timing": report["timing"],
        "cache": report["cache"],
        "coverage": report["coverage"],
    })
}

fn assert_success(profile: &ProfiledOutput) {
    assert!(
        profile.output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&profile.output.stderr)
    );
    #[cfg(target_os = "linux")]
    {
        assert!(profile.peak_rss_kib > 0, "RSS sampling never observed exec");
    }
}

#[test]
fn profiled_runner_enforces_active_deadline() {
    let temp = tempfile::tempdir().unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_profiled_with_timeout(
            Path::new("/bin/sh"),
            &[OsStr::new("-c"), OsStr::new("while :; do :; done")],
            temp.path(),
            Duration::from_millis(20),
        )
    }));

    assert!(result.is_err());
}

struct BaselineMeasurements {
    main: PathBuf,
    cache: PathBuf,
    small_cold: ProfiledOutput,
    small_warm: ProfiledOutput,
    cold: ProfiledOutput,
    warm: ProfiledOutput,
}

struct ChangeMeasurements {
    cycle: ProfiledOutput,
    one: ProfiledOutput,
    thousand: ProfiledOutput,
}

fn measure_changes(binary: &Path, main: &Path, cache: &Path) -> ChangeMeasurements {
    fs::write(main.join("src/f09999.ts"), cycle_source(9_999)).unwrap();
    let cycle = run_sense(binary, main, cache);
    assert_success(&cycle);
    assert_eq!(report(&cycle)["status"], "findings");
    assert_eq!(
        report(&cycle)["introducedCycles"][0]["memberCount"],
        LARGE_FILES
    );
    fs::write(
        main.join("src/f09999.ts"),
        source(9_999, LARGE_FILES, false),
    )
    .unwrap();

    fs::write(main.join("src/f05000.ts"), source(5_000, LARGE_FILES, true)).unwrap();
    let one = run_sense(binary, main, cache);
    assert_success(&one);
    assert_eq!(report(&one)["status"], "clean");
    assert_eq!(report(&one)["cache"]["misses"], 1);
    assert_eq!(
        report(&one)["observations"]["dependencyDeltas"][0]["runtimeDelta"],
        -1
    );

    for index in 0..CHANGED_FILES {
        fs::write(
            main.join(format!("src/f{index:05}.ts")),
            source(index, LARGE_FILES, true),
        )
        .unwrap();
    }
    let thousand = run_sense(binary, main, cache);
    assert_success(&thousand);
    let report = report(&thousand);
    assert_eq!(report["status"], "clean");
    assert_eq!(
        report["observations"]["dependencyDeltas"]
            .as_array()
            .unwrap()
            .len(),
        CHANGED_FILES + 1
    );
    assert_eq!(report["observations"]["truncated"], false);
    assert_eq!(report["observations"]["impactTruncated"], false);
    assert!(
        report["observations"]["dependencyDeltas"]
            .as_array()
            .unwrap()
            .iter()
            .all(|delta| delta["runtimeDelta"] == -1)
    );
    ChangeMeasurements {
        cycle,
        one,
        thousand,
    }
}

fn measure_baselines(binary: &Path, parent: &Path) -> BaselineMeasurements {
    let small = parent.join("small");
    let small_cache = parent.join("small-cache");
    initialize_fixture(&small, SMALL_FILES);
    let small_cold = run_sense(binary, &small, &small_cache);
    let small_warm = median_warm_profile(
        (0..WARM_SAMPLE_COUNT)
            .map(|_| run_sense(binary, &small, &small_cache))
            .collect(),
    );
    assert_success(&small_cold);
    assert_success(&small_warm);
    assert_eq!(
        report(&small_cold)["after"]["runtimeEdges"],
        SMALL_FILES - 1
    );
    assert_eq!(report(&small_cold)["cache"]["misses"], SMALL_FILES);

    let main = parent.join("main");
    let cache = parent.join("cache");
    initialize_fixture(&main, LARGE_FILES);
    let cold = run_sense(binary, &main, &cache);
    let warm = median_warm_profile(
        (0..WARM_SAMPLE_COUNT)
            .map(|_| run_sense(binary, &main, &cache))
            .collect(),
    );
    assert_large_baselines(&cold, &warm);
    BaselineMeasurements {
        main,
        cache,
        small_cold,
        small_warm,
        cold,
        warm,
    }
}

fn assert_large_baselines(cold: &ProfiledOutput, warm: &ProfiledOutput) {
    assert_success(cold);
    let cold_report = report(cold);
    assert_eq!(cold_report["status"], "clean");
    assert_eq!(cold_report["after"]["runtimeEdges"], LARGE_FILES - 1);
    assert_eq!(cold_report["cache"]["misses"], LARGE_FILES);

    assert_success(warm);
    let warm_report = report(warm);
    assert_eq!(warm_report["cache"]["hits"], LARGE_FILES);
    assert_eq!(warm_report["cache"]["misses"], 0);
}

fn median_warm_profile(mut profiles: Vec<ProfiledOutput>) -> ProfiledOutput {
    assert_eq!(profiles.len(), WARM_SAMPLE_COUNT);
    for profile in &profiles {
        assert_success(profile);
    }
    profiles.sort_by_key(|profile| {
        graph_phase_timings(profile)
            .iter()
            .map(|(_, duration)| duration)
            .sum::<u64>()
    });
    profiles.swap_remove(WARM_SAMPLE_COUNT / 2)
}

fn graph_phase_timings(profile: &ProfiledOutput) -> [(&'static str, u64); 4] {
    let report = report(profile);
    ["resolutionUs", "cyclesUs", "observationsUs", "dedupUs"]
        .map(|phase| (phase, report["timing"][phase].as_u64().unwrap()))
}

#[test]
#[ignore = "explicit 10k-file Sense measurement and worktree proof"]
fn ten_thousand_files_and_eight_worktrees_stay_bounded() {
    let temp = tempfile::tempdir().unwrap();
    let binary = assert_cmd::cargo::cargo_bin!("opcore");
    let BaselineMeasurements {
        main,
        cache,
        small_cold,
        small_warm,
        cold,
        warm,
    } = measure_baselines(binary, temp.path());

    let ChangeMeasurements {
        cycle: cycle_change,
        one: one_change,
        thousand: thousand_changes,
    } = measure_changes(binary, &main, &cache);

    git(&main, &["reset", "--hard", "-q", "HEAD"]);
    let empty_changed_verify = run_empty_changed_verify(binary, &main, &cache);
    assert_eq!(empty_changed_verify.output.status.code(), Some(0));
    assert_eq!(report(&empty_changed_verify)["status"], "not_checked");
    assert_eq!(
        report(&empty_changed_verify)["coverage"]["filesConsidered"],
        0
    );
    let worktrees = create_worktrees(&main, temp.path());
    let concurrent = run_concurrent(binary, &worktrees, &cache);
    for profile in &concurrent {
        assert_success(profile);
        assert_eq!(report(profile)["status"], "clean");
        assert_eq!(report(profile)["cache"]["misses"], 0);
    }
    let mut concurrent_wall_us = concurrent
        .iter()
        .map(|profile| profile.wall_us)
        .collect::<Vec<_>>();
    concurrent_wall_us.sort_unstable();
    let max_wall_us = *concurrent_wall_us.last().unwrap();
    let divergent_cache = temp.path().join("divergent-cache");
    apply_divergent_overlays(&worktrees);
    let divergent_cold = run_concurrent(binary, &worktrees, &divergent_cache);
    let divergent_warm = run_concurrent(binary, &worktrees, &divergent_cache);
    assert_divergent_results(&divergent_cold, false);
    assert_divergent_results(&divergent_warm, true);

    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "cold10k": measurement(&cold),
            "warm10kMedianOf3": measurement(&warm),
            "cold1k": measurement(&small_cold),
            "warm1kMedianOf3": measurement(&small_warm),
            "warmOneChange10k": measurement(&one_change),
            "warmCycle10k": measurement(&cycle_change),
            "warm1001Changes10k": measurement(&thousand_changes),
            "emptyChangedVerify10k": verify_measurement(&empty_changed_verify),
            "eightWorktrees": {
                "wallUs": concurrent_wall_us,
                "maxWallUs": max_wall_us,
                "measurements": concurrent.iter().map(measurement).collect::<Vec<_>>(),
            },
            "divergentWorktrees": {
                "cold": divergent_cold.iter().map(measurement).collect::<Vec<_>>(),
                "warm": divergent_warm.iter().map(measurement).collect::<Vec<_>>(),
            }
        }))
        .unwrap()
    );
}

fn create_worktrees(main: &Path, parent: &Path) -> Vec<PathBuf> {
    (0..8)
        .map(|index| {
            let path = parent.join(format!("worktree-{index}"));
            git(
                main,
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    &format!("worktree-{index}"),
                    path.to_str().unwrap(),
                ],
            );
            path
        })
        .collect()
}

fn apply_divergent_overlays(repos: &[PathBuf]) {
    fs::write(repos[0].join("src/f09999.ts"), cycle_source(9_999)).unwrap();
    fs::write(
        repos[1].join("src/f09999.ts"),
        "import type { value_0 } from './f00000';\nexport const value_9999 = 9999;\n",
    )
    .unwrap();
    fs::write(
        repos[2].join("src/f09999.ts"),
        "import './missing';\nexport const unresolved = true;\n",
    )
    .unwrap();
    fs::remove_file(repos[3].join("src/f05000.ts")).unwrap();
    let copied = fs::read(repos[4].join("src/f09000.ts")).unwrap();
    fs::write(repos[4].join("src/f05000.ts"), copied).unwrap();
    fs::write(
        repos[5].join("src/f09999.ts"),
        format!("// worktree five\n{}", source(9_999, LARGE_FILES, false)),
    )
    .unwrap();
    fs::write(
        repos[6].join("src/f09998.ts"),
        format!("// worktree six\n{}", source(9_998, LARGE_FILES, false)),
    )
    .unwrap();
    fs::write(
        repos[7].join("src/f07000.ts"),
        source(7_000, LARGE_FILES, true),
    )
    .unwrap();
}

fn assert_divergent_results(profiles: &[ProfiledOutput], warm: bool) {
    let reports = profiles.iter().map(report).collect::<Vec<_>>();
    for (profile, report) in profiles.iter().zip(&reports) {
        assert_success(profile);
        assert_eq!(report["cache"]["state"], "persistent");
        if warm {
            assert_eq!(report["cache"]["misses"], 0);
        }
    }
    let before_views = reports
        .iter()
        .map(|report| report["before"]["viewId"].as_str().unwrap())
        .collect::<BTreeSet<_>>();
    let after_views = reports
        .iter()
        .map(|report| report["after"]["viewId"].as_str().unwrap())
        .collect::<BTreeSet<_>>();
    assert_eq!(before_views.len(), 1);
    assert_eq!(after_views.len(), profiles.len());
    assert_eq!(reports[0]["status"], "findings");
    assert_eq!(reports[1]["status"], "clean");
    assert_eq!(reports[1]["after"]["typeOnlyEdges"], 1);
    assert_eq!(reports[2]["status"], "partial");
    assert_eq!(reports[2]["after"]["coverage"]["unresolvedReferences"], 1);
    assert_eq!(reports[3]["observations"]["impact"][0]["deleted"], true);
    assert_eq!(reports[4]["status"], "findings");
    assert_eq!(reports[4]["introducedDuplicates"][0]["afterCount"], 2);
    assert_eq!(
        reports[4]["introducedDuplicates"][0]["kind"],
        "identical_file"
    );
    assert_eq!(reports[5]["status"], "clean");
    assert_eq!(reports[6]["status"], "clean");
    assert_eq!(reports[7]["status"], "clean");
}

fn initialize_documentation_fixture(repo: &Path) {
    fs::create_dir_all(repo.join("src")).unwrap();
    fs::create_dir_all(repo.join("docs")).unwrap();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.name", "Test"]);
    git(repo, &["config", "user.email", "test@example.com"]);
    fs::write(repo.join("src/core.ts"), "export const core = 1;\n").unwrap();
    for index in 0..10 {
        fs::write(
            repo.join(format!("src/importer-{index}.ts")),
            "import './core';\nexport const importer = true;\n",
        )
        .unwrap();
    }
    fs::write(
        repo.join(".opcore.json"),
        r#"{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/core.ts","document":"docs/core.md"}]}}"#,
    )
    .unwrap();
    fs::write(repo.join("docs/core.md"), "Core ownership.\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "documented important module"]);
}

fn assert_documentation_worktree_results(profiles: &[ProfiledOutput], warm: bool) {
    let reports = profiles.iter().map(report).collect::<Vec<_>>();
    for (index, (profile, report)) in profiles.iter().zip(&reports).enumerate() {
        assert_success(profile);
        assert_eq!(report["documentationCoverage"]["documentsRequested"], 1);
        if index % 2 == 0 {
            assert_eq!(report["status"], "clean");
            assert_eq!(report["documentationCoverage"]["changedDocuments"], 1);
            assert!(
                report["documentationRequirements"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
        } else {
            assert_eq!(report["status"], "findings");
            assert_eq!(report["documentationCoverage"]["changedDocuments"], 0);
            assert_eq!(
                report["documentationRequirements"][0]["code"],
                "sense.documentation.document_not_updated"
            );
        }
        if warm {
            assert_eq!(report["cache"]["misses"], 0);
        }
    }
    let valid_as_of = reports
        .iter()
        .map(|report| report["validAsOf"].as_str().unwrap())
        .collect::<BTreeSet<_>>();
    assert_eq!(valid_as_of.len(), profiles.len());
}

#[test]
#[ignore = "explicit eight-worktree documentation isolation and cache proof"]
fn eight_divergent_documentation_worktrees_are_isolated() {
    let temp = tempfile::tempdir().unwrap();
    let binary = assert_cmd::cargo::cargo_bin!("opcore");
    let main = temp.path().join("main");
    let cache = temp.path().join("cache");
    initialize_documentation_fixture(&main);
    let worktrees = create_worktrees(&main, temp.path());
    for (index, repo) in worktrees.iter().enumerate() {
        fs::write(
            repo.join("src/core.ts"),
            format!("export const core_{index} = {index};\n"),
        )
        .unwrap();
        if index % 2 == 0 {
            fs::write(
                repo.join("docs/core.md"),
                format!("Core ownership for worktree {index}.\n"),
            )
            .unwrap();
        }
    }
    let cold = run_concurrent(binary, &worktrees, &cache);
    let warm = run_concurrent(binary, &worktrees, &cache);
    assert_documentation_worktree_results(&cold, false);
    assert_documentation_worktree_results(&warm, true);
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "cold": cold.iter().map(measurement).collect::<Vec<_>>(),
            "warm": warm.iter().map(measurement).collect::<Vec<_>>(),
        }))
        .unwrap()
    );
}

fn run_concurrent(binary: &Path, repos: &[PathBuf], cache: &Path) -> Vec<ProfiledOutput> {
    let handles = repos
        .iter()
        .map(|repo| {
            let binary = binary.to_owned();
            let repo = repo.clone();
            let cache = cache.to_owned();
            thread::spawn(move || run_sense(&binary, &repo, &cache))
        })
        .collect::<Vec<_>>();
    handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect()
}

#[tokio::test]
#[ignore = "explicit dense-edge graph boundedness proof"]
async fn dense_graph_is_exact_deterministic_and_bounded() {
    const DENSE_FILES: usize = 1_000;
    const FAN_OUT: usize = 200;

    let before = Arc::new(SourceSnapshot::new(
        (0..DENSE_FILES).map(|index| dense_file(index, DENSE_FILES, 0)),
    ));
    let after = Arc::new(SourceSnapshot::new(
        (0..DENSE_FILES).map(|index| dense_file(index, DENSE_FILES, FAN_OUT)),
    ));
    let changed_paths = after.paths().cloned().collect::<BTreeSet<_>>();
    let engine = SenseEngine::new();
    let report = engine
        .evaluate(
            SenseRequest {
                before: Arc::clone(&before),
                after: Arc::clone(&after),
                changed_paths: changed_paths.clone(),
                before_unsupported_files: 0,
                after_unsupported_files: 0,
                unsupported_changed_files: 0,
                dependency_metadata_changed_files: 0,
                go_modules: GoModuleViews::default(),
                valid_as_of: "dense".into(),
                options: SenseOptions::default(),
            },
            CancelToken::new(),
        )
        .await
        .unwrap();

    let expected_edges = FAN_OUT * (DENSE_FILES - FAN_OUT) + (1..FAN_OUT).sum::<usize>();
    assert_eq!(report.after.runtime_edges, expected_edges);
    assert!(!report.after.coverage.edges_truncated);
    assert!(report.introduced_cycles.is_empty());
    assert!(report.observations.impact_truncated);
    assert_eq!(report.status, SenseStatus::Incomplete);
    assert!(report.findings_truncated);
    assert!(report.observations.truncated);
    let repeated = engine
        .evaluate(
            SenseRequest {
                before,
                after,
                changed_paths,
                before_unsupported_files: 0,
                after_unsupported_files: 0,
                unsupported_changed_files: 0,
                dependency_metadata_changed_files: 0,
                go_modules: GoModuleViews::default(),
                valid_as_of: "dense-repeat".into(),
                options: SenseOptions::default(),
            },
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(report.status, repeated.status);
    assert_eq!(report.after, repeated.after);
    assert_eq!(report.introduced_cycles, repeated.introduced_cycles);
    assert_eq!(report.observations, repeated.observations);
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "denseEdges": expected_edges,
            "status": report.status,
            "timing": report.timing,
            "cache": report.cache,
        }))
        .unwrap()
    );
}

#[tokio::test]
#[ignore = "explicit many-baseline-SCC linearity proof"]
async fn ten_thousand_baseline_cycles_compare_linearly() {
    let before = Arc::new(SourceSnapshot::new(
        (0..LARGE_FILES).map(|index| baseline_cycle_file(index, false)),
    ));
    let after =
        Arc::new(SourceSnapshot::new((0..LARGE_FILES).map(|index| {
            baseline_cycle_file(index, index == LARGE_FILES - 1)
        })));
    let changed = RepoPath::from_protocol("src/f09999.ts").unwrap();
    let report = SenseEngine::new()
        .evaluate(
            SenseRequest {
                before,
                after,
                changed_paths: BTreeSet::from([changed]),
                before_unsupported_files: 0,
                after_unsupported_files: 0,
                unsupported_changed_files: 0,
                dependency_metadata_changed_files: 0,
                go_modules: GoModuleViews::default(),
                valid_as_of: "many-baseline-cycles".into(),
                options: SenseOptions::default(),
            },
            CancelToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(report.status, SenseStatus::Clean);
    assert!(report.introduced_cycles.is_empty());
    println!("manyBaselineCycles={}", report.timing.cycles_us);
}

fn baseline_cycle_file(index: usize, changed: bool) -> SourceFile {
    let changed = if changed { "// harmless edit\n" } else { "" };
    SourceFile::new(
        RepoPath::from_protocol(&format!("src/f{index:05}.ts")).unwrap(),
        format!("import './f{index:05}';\n{changed}export const value = {index};\n").into_bytes(),
        Language::TypeScript,
        "node".into(),
    )
}

fn dense_file(index: usize, files: usize, fan_out: usize) -> SourceFile {
    let mut source = String::new();
    for target in index + 1..(index + fan_out + 1).min(files) {
        writeln!(source, "import './f{target:04}';").unwrap();
    }
    writeln!(source, "export const value_{index} = {index};").unwrap();
    SourceFile::new(
        RepoPath::from_protocol(&format!("src/f{index:04}.ts")).unwrap(),
        source.into_bytes(),
        Language::TypeScript,
        "node".into(),
    )
}

#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::symlink,
    path::Path,
    process::{Command, Output, Stdio},
};

use serde_json::{Value, json};

fn binary() -> &'static Path {
    Path::new(assert_cmd::cargo::cargo_bin!("opcore"))
}

fn git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success());
}

fn initialize(repo: &Path) {
    fs::create_dir_all(repo.join("src")).unwrap();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.name", "Test"]);
    git(repo, &["config", "user.email", "test@example.com"]);
    fs::write(repo.join("src/a.ts"), "export const clean = true;\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "initial"]);
}

fn configure(config: &Path, receipt: &Path, remove: bool) -> Output {
    let mut command = Command::new(binary());
    command
        .arg("configure-hook")
        .args(["--agent", "codex", "--config"])
        .arg(config)
        .arg("--binary")
        .arg(binary())
        .arg("--receipt")
        .arg(receipt);
    if remove {
        command.arg("--remove");
    }
    command.output().unwrap()
}

fn hook_count(config: &Value) -> usize {
    config["hooks"]["PostToolUse"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|group| group["hooks"].as_array().unwrap())
        .filter(|hook| hook["statusMessage"] == "Running Opcore Verify and Project Sense")
        .count()
}

fn gate(repo: &Path, cache: &Path) -> Output {
    gate_with_payload(
        cache,
        &json!({
            "hook_event_name": "PostToolUse",
            "cwd": repo,
        }),
    )
}

fn gate_with_payload(cache: &Path, payload: &Value) -> Output {
    let mut command = Command::new(binary());
    command.arg("agent-gate");
    command.env("XDG_CACHE_HOME", cache);
    run_gate_with_payload(command, payload)
}

fn run_gate(command: Command, repo: &Path) -> Output {
    run_gate_with_payload(
        command,
        &json!({
            "hook_event_name": "PostToolUse",
            "cwd": repo,
        }),
    )
}

fn run_gate_with_payload(mut command: Command, payload: &Value) -> Output {
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let payload = serde_json::to_vec(&payload).unwrap();
    std::io::Write::write_all(child.stdin.as_mut().unwrap(), &payload).unwrap();
    drop(child.stdin.take());
    child.wait_with_output().unwrap()
}

fn initialized_repository(root: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let repo = root.join("repo");
    let cache = root.join("cache");
    fs::create_dir(&repo).unwrap();
    initialize(&repo);
    (repo, cache)
}

fn commit_shell_baseline(repo: &Path) {
    fs::write(repo.join("src/task.sh"), "printf '%s\\n' baseline\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "shell baseline"]);
}

fn blocking_feedback(repo: &Path, cache: &Path) -> String {
    let finding = gate(repo, cache);
    assert_eq!(finding.status.code(), Some(2));
    assert!(finding.stdout.is_empty());
    String::from_utf8(finding.stderr).unwrap()
}

#[test]
fn hook_install_is_additive_idempotent_and_surgically_reversible() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("agent/hooks.json");
    let receipt = temp.path().join("state/hook.json");
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    let original = json!({
        "env": { "EXISTING": "yes" },
        "hooks": { "PostToolUse": [{
            "matcher": "Other",
            "hooks": [{ "type": "command", "command": "existing", "timeout": 5 }]
        }, {
            "matcher": "apply_patch|Edit|Write",
            "hooks": [{
                "type": "command",
                "command": "echo opcore agent-gate user-owned",
                "timeout": 5
            }]
        }] }
    });
    fs::write(&config, serde_json::to_vec_pretty(&original).unwrap()).unwrap();

    assert!(configure(&config, &receipt, false).status.success());
    let mut legacy: Value = serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
    legacy.as_object_mut().unwrap().remove("ownedEntries");
    fs::write(&receipt, serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();
    let mut legacy_config: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    for group in legacy_config["hooks"]["PostToolUse"]
        .as_array_mut()
        .unwrap()
    {
        let mut legacy_group = false;
        for hook in group["hooks"].as_array_mut().unwrap() {
            if hook["statusMessage"] == "Running Opcore Verify and Project Sense" {
                hook["statusMessage"] = Value::from("Running Opcore Verify");
                legacy_group = true;
            }
        }
        if legacy_group {
            group["matcher"] = Value::from("apply_patch|Edit|Write");
        }
    }
    fs::write(&config, serde_json::to_vec_pretty(&legacy_config).unwrap()).unwrap();
    assert!(configure(&config, &receipt, false).status.success());
    let installed: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(installed["env"], original["env"]);
    assert_eq!(hook_count(&installed), 1);
    assert!(receipt.is_file());

    assert!(configure(&config, &receipt, true).status.success());
    let restored: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(restored, original);
    assert!(!receipt.exists());
}

#[test]
fn uninstall_removes_a_config_created_only_for_the_hook_and_refuses_symlinks() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("agent/hooks.json");
    let receipt = temp.path().join("state/hook.json");
    assert!(configure(&config, &receipt, false).status.success());
    assert!(config.is_file());
    assert!(configure(&config, &receipt, true).status.success());
    assert!(!config.exists());

    fs::create_dir_all(config.parent().unwrap()).unwrap();
    let outside = temp.path().join("outside.json");
    fs::write(&outside, "{}").unwrap();
    symlink(&outside, &config).unwrap();
    assert!(!configure(&config, &receipt, false).status.success());
    assert_eq!(fs::read_to_string(outside).unwrap(), "{}");
}

#[test]
fn post_write_gate_intervenes_on_disk_findings_and_skips_non_repositories() {
    let temp = tempfile::tempdir().unwrap();
    let (repo, cache) = initialized_repository(temp.path());

    assert!(gate(&repo, &cache).status.success());
    fs::write(
        repo.join("src/a.ts"),
        "export function violation(a,b,c,d,e,f) { return a; }\n",
    )
    .unwrap();
    let feedback = blocking_feedback(&repo, &cache);
    assert!(feedback.contains("requires intervention"));
    assert!(feedback.contains("complexity.max-parameters"));
    assert!(feedback.contains("src/a.ts:1"));
    assert!(feedback.contains("all selected uncommitted worktree changes against HEAD"));
    assert!(feedback.contains("not only the call that triggered this hook"));
    assert!(feedback.contains("The triggering PostToolUse call already executed"));
    assert!(feedback.contains("Matched calls will keep receiving the same feedback"));
    assert!(feedback.contains("does not repair them"));
    assert!(blocking_feedback(&repo.join("src"), &cache).contains("complexity.max-parameters"));

    assert!(gate(temp.path(), &cache).status.success());
    fs::create_dir(temp.path().join(".git")).unwrap();
    assert!(gate(temp.path(), &cache).status.success());
}

#[test]
fn post_tool_payload_shapes_intentionally_share_the_worktree_verdict() {
    let temp = tempfile::tempdir().unwrap();
    let (repo, cache) = initialized_repository(temp.path());
    fs::create_dir(repo.join("apps")).unwrap();
    fs::write(
        repo.join("apps/report.ts"),
        "export function report(a,b,c,d,e,f) { return a; }\n",
    )
    .unwrap();

    let payloads = [
        json!({
            "cwd": repo,
            "tool_name": "Bash",
            "tool_input": { "command": "pwd" },
        }),
        json!({
            "cwd": repo,
            "tool_name": "Edit",
            "tool_input": { "file_path": "src/a.ts" },
        }),
        json!({
            "cwd": repo,
            "tool_name": "Bash",
            "tool_input": { "command": "rm -rf /" },
        }),
        json!({ "cwd": repo }),
    ];
    let outputs = payloads
        .into_iter()
        .map(|payload| gate_with_payload(&cache, &payload))
        .collect::<Vec<_>>();

    for output in &outputs {
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
    }
    for output in outputs.iter().skip(1) {
        assert_eq!(output.stderr, outputs[0].stderr);
    }
    let feedback = String::from_utf8(outputs[0].stderr.clone()).unwrap();
    assert!(feedback.contains("apps/report.ts:1"));
    assert!(feedback.contains("not only the call that triggered this hook"));
}

#[test]
fn post_tool_gate_blocks_missing_git_and_damaged_repository_discovery() {
    let temp = tempfile::tempdir().unwrap();
    let (repo, cache) = initialized_repository(temp.path());
    let empty_path = temp.path().join("no-tools");
    fs::create_dir(&empty_path).unwrap();
    let mut command = Command::new(binary());
    command.arg("agent-gate").env("PATH", &empty_path);
    let missing_git = run_gate(command, &repo);
    assert_eq!(missing_git.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&missing_git.stderr).contains("could not discover"));
    assert!(String::from_utf8_lossy(&missing_git.stderr).contains("opcore doctor"));

    fs::remove_file(repo.join(".git/HEAD")).unwrap();
    let damaged = gate(&repo.join("src"), &cache);
    assert_eq!(damaged.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&damaged.stderr).contains("Git repository discovery failed"));
    let missing_path = gate(&repo.join("missing"), &cache);
    assert_eq!(missing_path.status.code(), Some(2));
}

#[test]
fn preflight_catches_bad_config_without_writing_or_requiring_the_future_binary() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("agent/hooks.json");
    let receipt = temp.path().join("state/hook.json");
    let future_binary = temp.path().join("bin/opcore");
    let preflight = || {
        Command::new(binary())
            .args(["configure-hook", "--agent", "codex", "--check", "--config"])
            .arg(&config)
            .arg("--receipt")
            .arg(&receipt)
            .arg("--binary")
            .arg(&future_binary)
            .output()
            .unwrap()
    };
    assert!(preflight().status.success());
    assert!(!config.parent().unwrap().exists());
    assert!(!receipt.parent().unwrap().exists());
    assert!(!future_binary.exists());
    fs::create_dir(config.parent().unwrap()).unwrap();
    for contents in [
        "{broken",
        r#"{"hooks":{"PostToolUse":{}}}"#,
        r#"{"hooks":{"PostToolUse":[{"matcher":"Other","hooks":false}]}}"#,
    ] {
        fs::write(&config, contents).unwrap();
        assert!(!preflight().status.success());
        assert_eq!(fs::read_to_string(&config).unwrap(), contents);
        assert!(!receipt.exists());
    }
}

#[test]
fn both_agent_matchers_cover_shell_and_mcp_tools_with_one_owned_hook() {
    let temp = tempfile::tempdir().unwrap();
    for agent in ["codex", "claude"] {
        let config = temp.path().join(format!("{agent}/hooks.json"));
        let receipt = temp.path().join(format!("{agent}/receipt.json"));
        let configured = Command::new(binary())
            .args(["configure-hook", "--agent", agent, "--config"])
            .arg(&config)
            .arg("--receipt")
            .arg(&receipt)
            .arg("--binary")
            .arg(binary())
            .output()
            .unwrap();
        assert!(configured.status.success());
        let config: Value = serde_json::from_slice(&fs::read(config).unwrap()).unwrap();
        assert_eq!(hook_count(&config), 1);
        let matcher = config["hooks"]["PostToolUse"][0]["matcher"]
            .as_str()
            .unwrap();
        for tool in [
            "Bash",
            "mcp__fs__write_file",
            "mcp__fs__read_file",
            "Edit",
            "Write",
        ] {
            let accepted = Command::new("bash")
                .args([
                    "--noprofile",
                    "--norc",
                    "-c",
                    r#"[[ "$1" =~ $2 ]]"#,
                    "matcher-test",
                    tool,
                    matcher,
                ])
                .env_remove("BASH_ENV")
                .status()
                .unwrap();
            assert!(accepted.success(), "{agent} hook missed {tool}");
        }
    }
}

#[test]
fn post_write_gate_blocks_on_confirmed_sense_findings_without_coverage_noise() {
    let temp = tempfile::tempdir().unwrap();
    let (repo, cache) = initialized_repository(temp.path());
    fs::write(
        repo.join("src/a.ts"),
        "import { b } from './b';\nexport const a = b + 1;\n",
    )
    .unwrap();
    fs::write(repo.join("src/b.ts"), "export const b = 1;\n").unwrap();
    fs::write(repo.join("src/task.sh"), "printf '%s\\n' baseline\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "graph baseline"]);

    fs::write(
        repo.join("src/b.ts"),
        "import { a } from './a';\nexport const b = a + 1;\n",
    )
    .unwrap();
    fs::write(repo.join("src/task.sh"), "printf '%s\\n' changed\n").unwrap();
    let feedback = blocking_feedback(&repo, &cache);
    assert!(feedback.contains("Project Sense requires intervention"));
    assert!(feedback.contains("sense.runtime_cycle"));
    assert!(feedback.contains("Project Sense coverage is partial"));
    assert!(feedback.contains("opcore run post-edit --repo . --json"));
    assert!(!feedback.contains("unsupported"));
    assert!(!feedback.contains("coverage after"));
    assert!(!feedback.contains("references:"));
}

#[test]
fn post_write_gate_does_not_block_or_expand_partial_sense_coverage() {
    let temp = tempfile::tempdir().unwrap();
    let (repo, cache) = initialized_repository(temp.path());
    commit_shell_baseline(&repo);

    fs::write(repo.join("src/task.sh"), "printf '%s\\n' changed\n").unwrap();
    let partial = gate(&repo, &cache);
    assert!(partial.status.success());
    assert!(partial.stdout.is_empty());
    let feedback = String::from_utf8(partial.stderr).unwrap();
    assert_eq!(
        feedback.trim(),
        "Project Sense coverage is partial. Run `opcore run post-edit --repo . --json` for details."
    );
}

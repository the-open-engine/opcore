use super::{WatchCliOptions, DEFAULT_WATCH_IDLE_TIMEOUT_MS, WATCH_IDLE_TIMEOUT_ENV};
use crate::extraction::normalize_watch_paths;
use std::path::PathBuf;

pub(super) fn parse_watch_args(args: &[String]) -> Result<WatchCliOptions, String> {
    let mut parsed = WatchArgs::default();
    let mut index = 0;
    while index < args.len() {
        let Some(arg) = args.get(index) else {
            break;
        };
        parsed.apply_arg(arg, args, &mut index)?;
        index += 1;
    }
    parsed.into_options()
}

#[derive(Default)]
struct WatchArgs {
    repo_root: Option<PathBuf>,
    base_ref: Option<String>,
    watch_paths: Vec<String>,
    poll_interval_ms: Option<u64>,
    idle_timeout_ms: Option<u64>,
    once: bool,
    max_wal_bytes: Option<u64>,
}

impl WatchArgs {
    fn apply_arg(&mut self, arg: &str, args: &[String], index: &mut usize) -> Result<(), String> {
        if arg == "watch" {
            return Ok(());
        }
        if arg == "--once" {
            self.once = true;
            return Ok(());
        }
        if let Some(flag) = WatchValueFlag::from_separate(arg) {
            *index += 1;
            return self.apply_value(flag, required_arg(args, *index, arg)?);
        }
        if let Some((flag, value)) = arg.split_once('=') {
            if let Some(flag) = WatchValueFlag::from_equals(flag) {
                return self.apply_value(flag, value);
            }
        }
        Err(format!("unsupported watch arg: {arg}"))
    }

    fn apply_value(&mut self, flag: WatchValueFlag, value: &str) -> Result<(), String> {
        match flag {
            WatchValueFlag::Repo => self.repo_root = Some(PathBuf::from(value)),
            WatchValueFlag::Base => self.base_ref = Some(value.to_string()),
            WatchValueFlag::Paths => self.watch_paths.extend(split_paths(value)),
            WatchValueFlag::PollIntervalMs => {
                self.poll_interval_ms = Some(parse_u64_flag("--poll-interval-ms", value)?);
            }
            WatchValueFlag::IdleTimeoutMs => {
                self.idle_timeout_ms = Some(parse_u64_flag("--idle-timeout-ms", value)?);
            }
            WatchValueFlag::MaxWalBytes => {
                self.max_wal_bytes = Some(parse_u64_flag("--max-wal-bytes", value)?);
            }
        }
        Ok(())
    }

    fn into_options(mut self) -> Result<WatchCliOptions, String> {
        let repo_root = self
            .repo_root
            .ok_or_else(|| "watch requires --repo".to_string())?;
        let poll_interval_ms = self.poll_interval_ms.unwrap_or(1000);
        let idle_timeout_ms = self.idle_timeout_ms.unwrap_or_else(env_idle_timeout_ms);
        let max_wal_bytes = self
            .max_wal_bytes
            .unwrap_or(crate::store::DEFAULT_WAL_BUDGET_BYTES);
        validate_watch_numbers(poll_interval_ms, max_wal_bytes)?;
        if self.watch_paths.is_empty() {
            self.watch_paths = env_watch_paths()?;
        }
        self.watch_paths = normalize_watch_paths(&self.watch_paths)?;
        Ok(WatchCliOptions {
            repo_root,
            base_ref: self.base_ref,
            watch_paths: self.watch_paths,
            poll_interval_ms,
            idle_timeout_ms,
            once: self.once,
            max_wal_bytes,
        })
    }
}

enum WatchValueFlag {
    Repo,
    Base,
    Paths,
    PollIntervalMs,
    IdleTimeoutMs,
    MaxWalBytes,
}

impl WatchValueFlag {
    fn from_separate(flag: &str) -> Option<Self> {
        match flag {
            "--repo" => Some(Self::Repo),
            "--base" => Some(Self::Base),
            "--paths" => Some(Self::Paths),
            "--poll-interval-ms" => Some(Self::PollIntervalMs),
            "--idle-timeout-ms" => Some(Self::IdleTimeoutMs),
            "--max-wal-bytes" => Some(Self::MaxWalBytes),
            _ => None,
        }
    }

    fn from_equals(flag: &str) -> Option<Self> {
        Self::from_separate(flag)
    }
}

fn parse_u64_flag(flag: &str, value: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|error| format!("invalid {flag}: {error}"))
}

fn validate_watch_numbers(poll_interval_ms: u64, max_wal_bytes: u64) -> Result<(), String> {
    if poll_interval_ms == 0 {
        return Err("--poll-interval-ms must be positive".to_string());
    }
    if max_wal_bytes == 0 {
        return Err("--max-wal-bytes must be positive".to_string());
    }
    Ok(())
}

fn required_arg<'a>(args: &'a [String], index: usize, flag: &str) -> Result<&'a str, String> {
    args.get(index)
        .map(String::as_str)
        .filter(|value| !value.starts_with("--"))
        .ok_or_else(|| format!("{flag} requires a value"))
}

fn split_paths(value: &str) -> Vec<String> {
    value
        .split([',', ':'])
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn env_watch_paths() -> Result<Vec<String>, String> {
    std::env::var("OPCORE_GRAPH_WATCH_PATHS")
        .map(|value| split_paths(&value))
        .or_else(|error| match error {
            std::env::VarError::NotPresent => Ok(Vec::new()),
            std::env::VarError::NotUnicode(_) => {
                Err("OPCORE_GRAPH_WATCH_PATHS must be UTF-8".to_string())
            }
        })
}

fn env_idle_timeout_ms() -> u64 {
    std::env::var(WATCH_IDLE_TIMEOUT_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_WATCH_IDLE_TIMEOUT_MS)
}

#[cfg(test)]
mod tests {
    use super::parse_watch_args;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    type TestResult = Result<(), String>;

    #[test]
    fn idle_timeout_defaults_to_thirty_minutes() -> TestResult {
        with_idle_env(None, || {
            let options = parse(&["watch", "--repo", "."])?;
            assert_eq!(options.idle_timeout_ms, 1_800_000);
            Ok(())
        })
    }

    #[test]
    fn idle_timeout_accepts_explicit_zero_disable() -> TestResult {
        with_idle_env(Some("900"), || {
            let options = parse(&["watch", "--repo", ".", "--idle-timeout-ms", "0"])?;
            assert_eq!(options.idle_timeout_ms, 0);
            Ok(())
        })
    }

    #[test]
    fn idle_timeout_explicit_value_wins_over_env() -> TestResult {
        with_idle_env(Some("900"), || {
            let options = parse(&["watch", "--repo", ".", "--idle-timeout-ms=500"])?;
            assert_eq!(options.idle_timeout_ms, 500);
            Ok(())
        })
    }

    #[test]
    fn idle_timeout_uses_valid_env_when_flag_absent() -> TestResult {
        with_idle_env(Some("700"), || {
            let options = parse(&["watch", "--repo", "."])?;
            assert_eq!(options.idle_timeout_ms, 700);
            Ok(())
        })
    }

    #[test]
    fn idle_timeout_ignores_invalid_env() -> TestResult {
        with_idle_env(Some("bad"), || {
            let options = parse(&["watch", "--repo", "."])?;
            assert_eq!(options.idle_timeout_ms, 1_800_000);
            Ok(())
        })
    }

    #[test]
    fn idle_timeout_rejects_invalid_cli_values() -> TestResult {
        with_idle_env(None, || {
            assert!(parse(&["watch", "--repo", ".", "--idle-timeout-ms", "bad"]).is_err());
            assert!(parse(&["watch", "--repo", ".", "--idle-timeout-ms=-1"]).is_err());
            Ok(())
        })
    }

    #[test]
    fn watch_paths_are_normalized_from_cli_and_env() -> TestResult {
        with_watch_env(Some("./src:tests\\unit"), None, || {
            let env_options = parse(&["watch", "--repo", "."])?;
            assert_eq!(env_options.watch_paths, vec!["src", "tests/unit"]);
            let cli_options = parse(&["watch", "--repo", ".", "--paths", "./src//,tests\\unit"])?;
            assert_eq!(cli_options.watch_paths, vec!["src", "tests/unit"]);
            Ok(())
        })
    }

    #[test]
    fn crg_watch_paths_do_not_scope_lattice_watch() -> TestResult {
        with_watch_env(None, Some("src"), || {
            let options = parse(&["watch", "--repo", "."])?;
            assert!(options.watch_paths.is_empty());
            Ok(())
        })
    }

    #[test]
    fn unsafe_watch_paths_are_rejected() -> TestResult {
        with_watch_env(None, None, || {
            for path in [
                "/tmp/src",
                "C:\\tmp\\src",
                "..",
                "../src",
                "src/../other",
                ".",
            ] {
                assert!(
                    parse(&["watch", "--repo", ".", "--paths", path]).is_err(),
                    "{path}"
                );
            }
            Ok(())
        })
    }

    fn parse(args: &[&str]) -> Result<super::super::WatchCliOptions, String> {
        parse_watch_args(
            &args
                .iter()
                .map(|entry| (*entry).to_string())
                .collect::<Vec<_>>(),
        )
    }

    fn with_idle_env<T>(
        value: Option<&str>,
        run: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = ENV_LOCK.lock().map_err(|error| error.to_string())?;
        let previous = std::env::var("OPCORE_GRAPH_WATCH_IDLE_TIMEOUT_MS").ok();
        match value {
            Some(value) => std::env::set_var("OPCORE_GRAPH_WATCH_IDLE_TIMEOUT_MS", value),
            None => std::env::remove_var("OPCORE_GRAPH_WATCH_IDLE_TIMEOUT_MS"),
        }
        let result = run();
        match previous {
            Some(value) => std::env::set_var("OPCORE_GRAPH_WATCH_IDLE_TIMEOUT_MS", value),
            None => std::env::remove_var("OPCORE_GRAPH_WATCH_IDLE_TIMEOUT_MS"),
        }
        result
    }

    fn with_watch_env<T>(
        opcore_value: Option<&str>,
        crg_value: Option<&str>,
        run: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = ENV_LOCK.lock().map_err(|error| error.to_string())?;
        let old_opcore = std::env::var("OPCORE_GRAPH_WATCH_PATHS").ok();
        let old_crg = std::env::var("CRG_WATCH_PATHS").ok();
        match opcore_value {
            Some(value) => std::env::set_var("OPCORE_GRAPH_WATCH_PATHS", value),
            None => std::env::remove_var("OPCORE_GRAPH_WATCH_PATHS"),
        }
        match crg_value {
            Some(value) => std::env::set_var("CRG_WATCH_PATHS", value),
            None => std::env::remove_var("CRG_WATCH_PATHS"),
        }
        let result = run();
        match old_opcore {
            Some(value) => std::env::set_var("OPCORE_GRAPH_WATCH_PATHS", value),
            None => std::env::remove_var("OPCORE_GRAPH_WATCH_PATHS"),
        }
        match old_crg {
            Some(value) => std::env::set_var("CRG_WATCH_PATHS", value),
            None => std::env::remove_var("CRG_WATCH_PATHS"),
        }
        result
    }
}

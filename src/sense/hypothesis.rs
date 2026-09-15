use std::{
    collections::BTreeMap, fs::OpenOptions, io::Read, os::unix::fs::OpenOptionsExt, path::Path,
};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;

use crate::{
    identity::hash_domain,
    json::parse_unique_json,
    limits::{MAX_FILES, MAX_FRAME_BYTES},
    path::RepoPath,
};

const HYPOTHETICAL_REQUEST_SCHEMA_VERSION: u32 = 1;

#[derive(Clone)]
pub(super) struct Hypothesis {
    pub overlays: BTreeMap<RepoPath, Option<Vec<u8>>>,
    pub digest: String,
}

impl Hypothesis {
    pub fn validate_configuration(&self, policy: &crate::policy::PolicySnapshot) -> Result<()> {
        let path = RepoPath::from_protocol(crate::policy::POLICY_PATH)?;
        if let Some(bytes) = self.overlays.get(&path) {
            policy.validate_hypothetical(bytes.as_deref())?;
        }
        Ok(())
    }

    pub fn selected(&self, targets: &crate::policy::TargetPolicy) -> Self {
        let mut hypothesis = self.clone();
        hypothesis.overlays.retain(|path, _| {
            !crate::source::git::is_source_candidate(path) || targets.includes(path)
        });
        hypothesis
    }

    pub fn read(argument: &Path) -> Result<Self> {
        let bytes = read_request_bytes(argument)?;
        let value = parse_unique_json(&bytes).context("parse unique hypothetical request JSON")?;
        let request: WireRequest =
            serde_json::from_value(value).context("validate hypothetical request schema")?;
        ensure!(
            request.schema_version == HYPOTHETICAL_REQUEST_SCHEMA_VERSION,
            "schemaVersion must be {HYPOTHETICAL_REQUEST_SCHEMA_VERSION}"
        );
        ensure!(
            request.changes.len() <= MAX_FILES,
            "hypothetical request exceeds {MAX_FILES} changes"
        );
        let overlays = collect_overlays(request.changes)?;
        let digest = hex::encode(hash_domain("sense-hypothesis/v1", &[&bytes]));
        Ok(Self {
            overlays,
            digest: format!("sha256:{digest}"),
        })
    }
}

fn read_request_bytes(argument: &Path) -> Result<Vec<u8>> {
    if argument == Path::new("-") {
        return read_bounded(std::io::stdin())
            .context("read hypothetical Sense request from stdin");
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(argument)
        .with_context(|| format!("open hypothetical request {}", argument.display()))?;
    ensure!(
        file.metadata()?.is_file(),
        "hypothetical request must be a regular file"
    );
    read_bounded(file).context("read hypothetical Sense request")
}

fn collect_overlays(changes: Vec<WireChange>) -> Result<BTreeMap<RepoPath, Option<Vec<u8>>>> {
    let mut overlays = BTreeMap::new();
    for change in changes {
        let (path, content) = match change {
            WireChange::Write { path, content } => (path, Some(content.into_bytes())),
            WireChange::Delete { path } => (path, None),
        };
        let path = RepoPath::from_protocol(&path).context("validate hypothetical path")?;
        ensure!(
            overlays.insert(path.clone(), content).is_none(),
            "duplicate hypothetical path {path}"
        );
    }
    Ok(overlays)
}

fn read_bounded(mut reader: impl Read) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_FRAME_BYTES,
        "hypothetical request exceeds {MAX_FRAME_BYTES} bytes"
    );
    Ok(bytes)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireRequest {
    schema_version: u32,
    changes: Vec<WireChange>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case", tag = "action")]
enum WireChange {
    Write { path: String, content: String },
    Delete { path: String },
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn strict_request_parses_writes_and_deletes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("request.json");
        fs::write(
            &path,
            concat!(
                r#"{"schemaVersion":1,"changes":["#,
                r#"{"action":"write","path":"src/a.ts","content":"x"},"#,
                r#"{"action":"delete","path":"src/b.ts"}]}"#,
            ),
        )
        .unwrap();
        let request = Hypothesis::read(&path).unwrap();
        assert_eq!(request.overlays.len(), 2);
        assert_eq!(
            request.overlays[&RepoPath::from_protocol("src/a.ts").unwrap()],
            Some(b"x".to_vec())
        );
        assert_eq!(
            request.overlays[&RepoPath::from_protocol("src/b.ts").unwrap()],
            None
        );
        assert!(request.digest.starts_with("sha256:"));
    }

    #[test]
    fn rejects_duplicates_unknown_fields_and_unsafe_paths() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("request.json");
        for invalid in [
            r#"{"schemaVersion":1,"changes":[],"extra":true}"#,
            r#"{"schemaVersion":1,"changes":[{"action":"delete","path":"a.ts","extra":true}]}"#,
            r#"{"schemaVersion":1,"changes":[{"action":"delete","path":"a.ts"},{"action":"delete","path":"a.ts"}]}"#,
            r#"{"schemaVersion":1,"changes":[{"action":"delete","path":"../a.ts"}]}"#,
        ] {
            fs::write(&path, invalid).unwrap();
            assert!(Hypothesis::read(&path).is_err(), "{invalid}");
        }
    }
}

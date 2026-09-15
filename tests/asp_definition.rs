use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const SOURCE_COMMIT: &str = "aa6d17135bc3f64d9fc3468251d802bbed284064";
const SNAPSHOT_DIGEST: &str = "1586b002d3fd8cffd94f5da9de73283090a462d598c58c380c2e634ad1fbe95e";
const SNAPSHOT_FILE_COUNT: usize = 150;
const SNAPSHOT_BYTE_COUNT: usize = 831_478;

const SNAPSHOT_ROOTS: &[&str] = &[
    "GLOSSARY.md",
    "spec",
    "schemas",
    "examples",
    "decisions",
    "docs/conformance",
    "docs/governance",
    "tests/conformance/fixtures",
];

#[test]
fn asp_definition_matches_source_record_and_all_json_is_well_formed() {
    let bundle_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("asp");
    let mut files = Vec::new();

    for relative in SNAPSHOT_ROOTS {
        collect_regular_files(&bundle_root.join(relative), &mut files);
    }
    files.sort_by_key(|path| repository_relative(&bundle_root, path));

    let mut hasher = Sha256::new();
    let mut byte_count = 0;
    for path in &files {
        let relative = repository_relative(&bundle_root, path);
        let bytes = fs::read(path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(&bytes);
        byte_count += bytes.len();

        if path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_else(|error| {
                panic!("invalid JSON in {}: {error}", path.display());
            });
        }
    }

    assert_eq!(files.len(), SNAPSHOT_FILE_COUNT);
    assert_eq!(byte_count, SNAPSHOT_BYTE_COUNT);
    assert_eq!(hex::encode(hasher.finalize()), SNAPSHOT_DIGEST);

    let source = fs::read_to_string(bundle_root.join("SOURCE.json"))
        .unwrap_or_else(|error| panic!("failed to read ASP source record: {error}"));
    let source: serde_json::Value = serde_json::from_str(&source)
        .unwrap_or_else(|error| panic!("invalid ASP source record: {error}"));
    assert_eq!(source["upstream"]["commit"], SOURCE_COMMIT);
    assert_eq!(source["snapshot"]["digest"], SNAPSHOT_DIGEST);
    assert_eq!(source["snapshot"]["fileCount"], SNAPSHOT_FILE_COUNT);
    assert_eq!(source["snapshot"]["byteCount"], SNAPSHOT_BYTE_COUNT);
}

fn collect_regular_files(path: &Path, files: &mut Vec<PathBuf>) {
    let metadata = fs::symlink_metadata(path)
        .unwrap_or_else(|error| panic!("failed to inspect {}: {error}", path.display()));
    assert!(
        !metadata.file_type().is_symlink(),
        "ASP bundle cannot contain symlinks"
    );

    if metadata.is_file() {
        files.push(path.to_path_buf());
        return;
    }

    assert!(
        metadata.is_dir(),
        "ASP bundle entries must be files or directories"
    );
    for entry in fs::read_dir(path)
        .unwrap_or_else(|error| panic!("failed to enumerate {}: {error}", path.display()))
    {
        let entry = entry.unwrap_or_else(|error| {
            panic!("failed to read an entry below {}: {error}", path.display());
        });
        collect_regular_files(&entry.path(), files);
    }
}

fn repository_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or_else(|error| panic!("{} is outside {}: {error}", path.display(), root.display()))
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

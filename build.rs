use std::{fs, path::Path};

use sha2::{Digest, Sha256};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for directory in ["src", "asp"] {
        println!("cargo:rerun-if-changed={directory}");
    }
    let mut paths = vec![
        "Cargo.lock".to_owned(),
        "Cargo.toml".to_owned(),
        "build.rs".to_owned(),
        "rust-toolchain.toml".to_owned(),
    ];
    collect(Path::new("src"), &mut paths)?;
    collect(Path::new("asp"), &mut paths)?;
    paths.sort();

    let mut hasher = Sha256::new();
    hasher.update(b"opcore-build/v2\0");
    for path in &paths {
        let bytes = fs::read(path)?;
        hasher.update(u64::try_from(path.len())?.to_be_bytes());
        hasher.update(path.as_bytes());
        hasher.update(u64::try_from(bytes.len())?.to_be_bytes());
        hasher.update(bytes);
        println!("cargo:rerun-if-changed={path}");
    }
    println!(
        "cargo:rustc-env=OPCORE_BUILD_DIGEST=sha256:{}",
        hex::encode(hasher.finalize())
    );
    Ok(())
}

fn collect(directory: &Path, paths: &mut Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            collect(&path, paths)?;
        } else if entry.file_type()?.is_file() {
            paths.push(path.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

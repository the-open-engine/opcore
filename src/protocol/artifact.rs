//! Stable, bounded hashing for executable artifacts.

use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read as _},
    path::Path,
    time::SystemTime,
};

use sha2::{Digest as _, Sha256};

pub(super) const MAX_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileIdentity {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
}

impl FileIdentity {
    fn capture(metadata: &Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt as _;

        Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
            #[cfg(unix)]
            changed_seconds: metadata.ctime(),
            #[cfg(unix)]
            changed_nanoseconds: metadata.ctime_nsec(),
        }
    }
}

struct DigestSink(Sha256);

impl DigestSink {
    fn new() -> Self {
        Self(Sha256::new())
    }

    fn finish(self) -> String {
        format!("sha256:{}", hex::encode(self.0.finalize()))
    }
}

impl io::Write for DigestSink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct BoundFile {
    file: File,
    identity: FileIdentity,
}

pub(super) fn digest_path(path: &Path) -> io::Result<String> {
    let bound = bind_path(path)?;
    digest_bound_path(path, bound)
}

fn digest_bound_path(path: &Path, bound: BoundFile) -> io::Result<String> {
    let BoundFile { mut file, identity } = bound;
    let digest = digest_open_file(&mut file, &identity)?;
    validate_path_binding(path, &identity)?;
    Ok(digest)
}

fn bind_path(path: &Path) -> io::Result<BoundFile> {
    let before = fs::symlink_metadata(path)?;
    validate_metadata(&before)?;
    let identity = FileIdentity::capture(&before);
    let file = open_no_follow(path)?;
    let opened = file.metadata()?;
    validate_metadata(&opened)?;
    validate_stable(&identity, &opened)?;
    Ok(BoundFile { file, identity })
}

fn digest_open_file(file: &mut File, identity: &FileIdentity) -> io::Result<String> {
    let maximum = identity
        .len
        .checked_add(1)
        .ok_or_else(|| io::Error::other("executable byte bound overflowed"))?;
    let mut digest = DigestSink::new();
    let total = io::copy(&mut file.take(maximum), &mut digest)?;
    if total != identity.len {
        return Err(io::Error::other(
            "executable changed length while it was hashed",
        ));
    }
    validate_stable(identity, &file.metadata()?)?;
    Ok(digest.finish())
}

fn open_no_follow(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

fn validate_metadata(metadata: &Metadata) -> io::Result<()> {
    if !metadata.file_type().is_symlink()
        && metadata.is_file()
        && metadata.len() <= MAX_EXECUTABLE_BYTES
    {
        Ok(())
    } else {
        Err(io::Error::other("executable is not a bounded regular file"))
    }
}

fn validate_stable(before: &FileIdentity, after: &Metadata) -> io::Result<()> {
    if before == &FileIdentity::capture(after) {
        Ok(())
    } else {
        Err(io::Error::other("executable changed while it was hashed"))
    }
}

fn validate_path_binding(path: &Path, opened: &FileIdentity) -> io::Result<()> {
    let after = fs::symlink_metadata(path)?;
    validate_metadata(&after)?;
    validate_stable(opened, &after)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_more_bytes_than_the_opened_file_identity_declared() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("artifact");
        std::fs::write(&path, b"artifact").unwrap();
        let mut file = File::open(&path).unwrap();
        let metadata = file.metadata().unwrap();
        std::fs::write(&path, b"artifact grew").unwrap();

        assert!(digest_open_file(&mut file, &FileIdentity::capture(&metadata)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_atomic_path_replacement_after_open() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("artifact");
        let replacement = directory.path().join("replacement");
        std::fs::write(&path, b"original00").unwrap();
        std::fs::write(&replacement, b"replaced00").unwrap();
        let modified = path.metadata().unwrap().modified().unwrap();
        File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();

        let bound = bind_path(&path).unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        let result = digest_bound_path(&path, bound);

        assert!(result.is_err());
    }
}

use std::{fmt, path::PathBuf};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use thiserror::Error;

pub const MAX_REPOSITORY_PATH_BYTES: usize = 4_096;

#[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RepoPath(Vec<u8>);

#[derive(Debug, Error, Eq, PartialEq)]
pub enum PathError {
    #[error("repository path is empty")]
    Empty,
    #[error("repository path must be relative")]
    Absolute,
    #[error("repository path contains an empty, dot, or parent component")]
    InvalidComponent,
    #[error("repository path contains NUL")]
    Nul,
    #[error("repository path exceeds {MAX_REPOSITORY_PATH_BYTES} bytes")]
    TooLong,
}

impl RepoPath {
    pub(crate) fn request_marker() -> Self {
        Self(b"_request".to_vec())
    }

    /// Constructs a validated repository-relative Git path.
    ///
    /// # Errors
    ///
    /// Returns [`PathError`] when the byte path is empty, absolute, oversized, contains NUL, or
    /// contains an ambiguous component.
    pub fn new(bytes: impl Into<Vec<u8>>) -> Result<Self, PathError> {
        let bytes = bytes.into();
        validate(&bytes)?;
        Ok(Self(bytes))
    }

    /// Constructs a validated repository path from protocol UTF-8.
    ///
    /// # Errors
    ///
    /// Returns [`PathError`] when the value contains backslashes or violates repository path
    /// invariants.
    pub fn from_protocol(value: &str) -> Result<Self, PathError> {
        if value.as_bytes().contains(&b'\\') {
            return Err(PathError::InvalidComponent);
        }
        Self::new(value.as_bytes())
    }

    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    #[must_use]
    pub fn as_utf8(&self) -> Option<&str> {
        std::str::from_utf8(&self.0).ok()
    }

    #[must_use]
    pub fn to_path_buf(&self) -> PathBuf {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            PathBuf::from(std::ffi::OsString::from_vec(self.0.clone()))
        }
        #[cfg(not(unix))]
        {
            PathBuf::from(String::from_utf8_lossy(&self.0).into_owned())
        }
    }

    #[must_use]
    pub fn display_lossless(&self) -> String {
        let mut output = String::new();
        for &byte in &self.0 {
            match byte {
                b' '..=b'~' if byte != b'\\' => output.push(char::from(byte)),
                b'\\' => output.push_str("\\\\"),
                _ => {
                    const HEX: &[u8; 16] = b"0123456789abcdef";
                    output.push_str("\\x");
                    output.push(char::from(HEX[usize::from(byte >> 4)]));
                    output.push(char::from(HEX[usize::from(byte & 0x0f)]));
                }
            }
        }
        output
    }
}

fn validate(bytes: &[u8]) -> Result<(), PathError> {
    if bytes.is_empty() {
        return Err(PathError::Empty);
    }
    if bytes.len() > MAX_REPOSITORY_PATH_BYTES {
        return Err(PathError::TooLong);
    }
    if bytes.contains(&0) {
        return Err(PathError::Nul);
    }
    if bytes.first() == Some(&b'/') || bytes.first() == Some(&b'\\') {
        return Err(PathError::Absolute);
    }
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(PathError::Absolute);
    }
    if bytes
        .split(|byte| matches!(byte, b'/' | b'\\'))
        .any(|part| part.is_empty() || part == b"." || part == b"..")
    {
        return Err(PathError::InvalidComponent);
    }
    Ok(())
}

impl fmt::Debug for RepoPath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("RepoPath")
            .field(&self.display_lossless())
            .finish()
    }
}

impl fmt::Display for RepoPath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.display_lossless())
    }
}

impl Serialize for RepoPath {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.as_utf8()
            .map_or_else(|| self.display_lossless(), str::to_owned)
            .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for RepoPath {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::from_protocol(&value).map_err(de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_escape_and_ambiguous_components() {
        for invalid in [
            "", "/tmp/a", "../a", "a/../b", "a//b", "C:/a", "a\\.\\b", "a\\b",
        ] {
            assert!(RepoPath::from_protocol(invalid).is_err(), "{invalid}");
        }
        assert!(RepoPath::from_protocol("src/lib.rs").is_ok());
    }

    #[test]
    fn deterministic_fuzz_paths_never_panic_or_escape_validation() {
        let mut state = 0xd1b5_4a32_d192_ed03u64;
        for case in 0..4_096usize {
            let length = case % 257;
            let bytes = (0..length)
                .map(|_| {
                    state = state
                        .wrapping_mul(2_862_933_555_777_941_757)
                        .wrapping_add(3_037_000_493);
                    state.to_le_bytes()[5]
                })
                .collect::<Vec<_>>();
            if let Ok(path) = RepoPath::new(bytes) {
                assert!(!path.as_bytes().is_empty());
                assert!(!path.as_bytes().starts_with(b"/"));
                drop(path.display_lossless());
                drop(path.to_path_buf());
                drop(serde_json::to_vec(&path));
            }
        }
    }
}

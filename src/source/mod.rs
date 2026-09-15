use thiserror::Error;

use crate::path::RepoPath;

pub mod git;
mod languages;
pub mod snapshot;

pub(crate) use languages::{has_extension, strip_language_suffix};

#[derive(Debug, Error)]
pub enum SourceError {
    #[error("not a Git worktree")]
    NotRepository,
    #[error("source path not found: {0}")]
    NotFound(RepoPath),
    #[error("source access denied: {0}")]
    Denied(String),
    #[error("source changed during capture: {0}")]
    Changed(String),
    #[error("source view is incomplete: {0}")]
    Incomplete(String),
    #[error("invalid source: {0}")]
    Invalid(String),
    #[error("source I/O failed: {0}")]
    Io(String),
}

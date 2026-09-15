use std::{collections::BTreeMap, sync::Arc};

use crate::{
    identity::{ContentViewId, hash_domain},
    model::SourceFile,
    path::RepoPath,
};

pub struct SourceSnapshot {
    id: ContentViewId,
    files: BTreeMap<RepoPath, Arc<SourceFile>>,
}

impl SourceSnapshot {
    #[must_use]
    pub fn new(files: impl IntoIterator<Item = SourceFile>) -> Self {
        let files: BTreeMap<_, _> = files
            .into_iter()
            .map(|file| (file.path.clone(), Arc::new(file)))
            .collect();
        let mut manifest = Vec::new();
        for (path, file) in &files {
            manifest.extend_from_slice(&(path.as_bytes().len() as u64).to_be_bytes());
            manifest.extend_from_slice(path.as_bytes());
            let language = match file.language {
                crate::model::Language::JavaScript => b"javascript".as_slice(),
                crate::model::Language::TypeScript => b"typescript".as_slice(),
                crate::model::Language::Rust => b"rust".as_slice(),
                crate::model::Language::Python => b"python".as_slice(),
                crate::model::Language::Go => b"go".as_slice(),
                crate::model::Language::Hcl => b"hcl".as_slice(),
                crate::model::Language::Shell => b"shell".as_slice(),
                crate::model::Language::Protobuf => b"protobuf".as_slice(),
            };
            manifest.extend_from_slice(&(language.len() as u64).to_be_bytes());
            manifest.extend_from_slice(language);
            manifest.extend_from_slice(&(file.language_mode.len() as u64).to_be_bytes());
            manifest.extend_from_slice(file.language_mode.as_bytes());
            manifest.extend_from_slice(file.content_id.as_bytes());
        }
        Self {
            id: ContentViewId::from_bytes(hash_domain("source-snapshot/v2", &[&manifest])),
            files,
        }
    }

    #[must_use]
    pub const fn id(&self) -> ContentViewId {
        self.id
    }

    pub fn paths(&self) -> impl Iterator<Item = &RepoPath> {
        self.files.keys()
    }

    pub fn files(&self) -> impl Iterator<Item = &SourceFile> {
        self.files.values().map(AsRef::as_ref)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.files.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    #[must_use]
    pub fn read(&self, path: &RepoPath) -> Option<Arc<SourceFile>> {
        self.files.get(path).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Language;

    #[test]
    fn identity_includes_language_mode() {
        let path = RepoPath::from_protocol("src/lib.rs").unwrap();
        let stable = SourceSnapshot::new([SourceFile::new(
            path.clone(),
            b"fn value() {}\n".to_vec(),
            Language::Rust,
            "rust:2021".into(),
        )]);
        let modern = SourceSnapshot::new([SourceFile::new(
            path,
            b"fn value() {}\n".to_vec(),
            Language::Rust,
            "rust:2024".into(),
        )]);

        assert_ne!(stable.id(), modern.id());
    }

    #[test]
    fn identity_includes_language() {
        let path = RepoPath::from_protocol("src/value").unwrap();
        let javascript = SourceSnapshot::new([SourceFile::new(
            path.clone(),
            b"export const value = 1;\n".to_vec(),
            Language::JavaScript,
            "node".into(),
        )]);
        let typescript = SourceSnapshot::new([SourceFile::new(
            path,
            b"export const value = 1;\n".to_vec(),
            Language::TypeScript,
            "node".into(),
        )]);

        assert_ne!(javascript.id(), typescript.id());
    }
}

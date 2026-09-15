use std::{collections::BTreeMap, sync::Arc};

use crate::{
    analysis::{self, AnalysisError},
    cache::{CacheError, FactCache},
    cancel::CancelToken,
    identity::FileFactKey,
    limits::RuleLimits,
    model::{FileFacts, SourceFile},
};

pub(crate) type FactMap = BTreeMap<FileFactKey, Arc<FileFacts>>;

pub(crate) fn load(
    file: &SourceFile,
    limits: &RuleLimits,
    parser_options: &[u8],
    cache: &dyn FactCache,
    cancel: &CancelToken,
) -> Result<Arc<FileFacts>, AnalysisError> {
    if cancel.is_cancelled() {
        return Err(AnalysisError::Cancelled);
    }
    let key = key(file, parser_options);
    match cache.get(key) {
        Ok(Some(_)) if cancel.is_cancelled() => return Err(AnalysisError::Cancelled),
        Ok(Some(facts)) => return Ok(facts),
        Err(CacheError::NonDeterministic) => return Err(nondeterministic_cache_error()),
        Ok(None) | Err(_) => {}
    }
    let facts = Arc::new(analysis::analyze(file, limits, cancel)?);
    if let Err(CacheError::NonDeterministic) = cache.put(key, Arc::clone(&facts)) {
        return Err(nondeterministic_cache_error());
    }
    Ok(facts)
}

#[must_use]
pub(crate) fn key(file: &SourceFile, parser_options: &[u8]) -> FileFactKey {
    FileFactKey::new(
        file.content_id,
        &file.language_mode,
        parser_options,
        analysis::FACT_ABI,
    )
}

fn nondeterministic_cache_error() -> AnalysisError {
    AnalysisError::Parser(CacheError::NonDeterministic.to_string())
}

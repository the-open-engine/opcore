pub mod collector;
pub mod manifest;

use super::diagnostics::error;
use super::discovery::DiscoveredSource;
use super::facts::{self, FileFacts};
use crate::protocol::{
    GraphExtractionDiagnostic, GraphExtractionDiagnosticCategory, GraphFactNode,
};
use manifest::RustManifest;

pub fn extract_file_facts(
    source: &DiscoveredSource,
    file_node: GraphFactNode,
    source_text: &str,
    manifest: &RustManifest,
) -> Result<FileFacts, GraphExtractionDiagnostic> {
    let parsed = syn::parse_file(source_text).map_err(|parse_error| {
        error(
            GraphExtractionDiagnosticCategory::ParseError,
            format!("failed to parse Rust source: {parse_error}"),
            Some(source.relative_path.clone()),
            Some(source.language.as_str().to_string()),
        )
    })?;
    Ok(collector::collect_file_facts(
        source.relative_path.clone(),
        file_node,
        &parsed,
        manifest,
    ))
}

pub fn file_facts_without_ast(source: &DiscoveredSource, file_node: GraphFactNode) -> FileFacts {
    facts::file_facts_without_ast(source, file_node)
}

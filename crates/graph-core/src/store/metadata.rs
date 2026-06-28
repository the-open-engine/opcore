use super::schema::user_version;
use super::types::FreshnessState;
use super::{StoreError, StoreResult};
use crate::extraction::{
    collect_source_file_hashes, ExtractionOptions, SourceFileHash, EXTRACTION_GENERATED_AT,
};
use crate::protocol::{GraphExtractionDiagnostic, GraphFreshness, GraphSnapshotMetadata};
use crate::{GRAPH_PROVIDER_NAME, GRAPH_SCHEMA_VERSION};
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use std::collections::BTreeMap;
use std::path::Path;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

pub(super) fn validate_metadata_json(connection: &Connection) -> StoreResult<()> {
    validate_metadata_table_json(
        connection,
        "metadata",
        "lattice_snapshot_metadata",
        "lattice_diagnostics_json",
    )?;
    validate_metadata_table_json(
        connection,
        "lattice_store",
        "metadata_json",
        "diagnostics_json",
    )
}

fn validate_metadata_table_json(
    connection: &Connection,
    table: &str,
    metadata_key: &str,
    diagnostics_key: &str,
) -> StoreResult<()> {
    let mut statement = connection.prepare(&format!(
        "select key, value from {table} where key in (?1, ?2)"
    ))?;
    let rows = statement.query_map(params![metadata_key, diagnostics_key], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let check = MetadataJsonCheck {
        connection,
        table,
        metadata_key,
        diagnostics_key,
    };
    for (key, value) in collect_rows(rows)? {
        validate_metadata_row(&check, &key, &value)?;
    }
    Ok(())
}

struct MetadataJsonCheck<'a> {
    connection: &'a Connection,
    table: &'a str,
    metadata_key: &'a str,
    diagnostics_key: &'a str,
}

fn validate_metadata_row(check: &MetadataJsonCheck<'_>, key: &str, value: &str) -> StoreResult<()> {
    if key == check.metadata_key {
        let metadata =
            parse_metadata_json(check.connection, check.table, check.metadata_key, value)?;
        validate_snapshot_metadata(check.connection, check.table, check.metadata_key, &metadata)?;
    } else if key == check.diagnostics_key {
        parse_diagnostics_json(check.connection, check.table, check.diagnostics_key, value)?;
    }
    Ok(())
}

fn parse_metadata_json(
    connection: &Connection,
    table: &str,
    key: &str,
    value: &str,
) -> StoreResult<GraphSnapshotMetadata> {
    parse_json(value).map_err(|error| StoreError::SchemaMismatch {
        message: format!("{table}.{key} is corrupt JSON: {error}"),
        actual_version: user_version(connection).unwrap_or_default(),
    })
}

fn parse_diagnostics_json(
    connection: &Connection,
    table: &str,
    key: &str,
    value: &str,
) -> StoreResult<()> {
    parse_json::<Vec<GraphExtractionDiagnostic>>(value)
        .map(|_| ())
        .map_err(|error| StoreError::SchemaMismatch {
            message: format!("{table}.{key} is corrupt JSON: {error}"),
            actual_version: user_version(connection).unwrap_or_default(),
        })
}

fn validate_snapshot_metadata(
    connection: &Connection,
    table: &str,
    key: &str,
    metadata: &GraphSnapshotMetadata,
) -> StoreResult<()> {
    if metadata.schema_version != GRAPH_SCHEMA_VERSION {
        return Err(StoreError::SchemaMismatch {
            message: format!(
                "{table}.{key} schemaVersion {} does not match GraphProvider {}",
                metadata.schema_version, GRAPH_SCHEMA_VERSION
            ),
            actual_version: metadata.schema_version,
        });
    }
    if metadata.provider != GRAPH_PROVIDER_NAME {
        return Err(StoreError::SchemaMismatch {
            message: format!(
                "{table}.{key} provider {} does not match {GRAPH_PROVIDER_NAME}",
                metadata.provider
            ),
            actual_version: user_version(connection).unwrap_or_default(),
        });
    }
    for (field, value) in [
        ("generatedAt", metadata.generated_at.as_str()),
        (
            "freshness.generatedAt",
            metadata.freshness.generated_at.as_str(),
        ),
    ] {
        if OffsetDateTime::parse(value, &Rfc3339).is_err() {
            return Err(StoreError::SchemaMismatch {
                message: format!("{table}.{key} {field} is not RFC3339: {value}"),
                actual_version: user_version(connection).unwrap_or_default(),
            });
        }
    }
    Ok(())
}

pub(super) fn read_optional_json<T: DeserializeOwned>(
    connection: &Connection,
    sql: &str,
) -> StoreResult<Option<T>> {
    let value: Option<String> = connection.query_row(sql, [], |row| row.get(0)).optional()?;
    value
        .map(|value| parse_json(&value))
        .transpose()
        .map_err(StoreError::Json)
}

fn parse_json<T: DeserializeOwned>(value: &str) -> Result<T, serde_json::Error> {
    serde_json::from_str(value)
}

pub(super) fn collect_rows<T, F>(rows: rusqlite::MappedRows<'_, F>) -> StoreResult<Vec<T>>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let mut values = Vec::new();
    for row in rows {
        values.push(row?);
    }
    Ok(values)
}

pub(super) fn optional_json(value: &Option<serde_json::Value>) -> StoreResult<Option<String>> {
    value
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(Into::into)
}

pub(super) fn current_source_hashes(
    repo_root: &Path,
    watch_paths: &[String],
) -> crate::extraction::SourceFileHashResult {
    let mut extraction_options = ExtractionOptions::new(repo_root);
    extraction_options.watch_paths = watch_paths.to_vec();
    collect_source_file_hashes(extraction_options)
}

pub(super) fn source_hash_discovery_failed(diagnostics: &[GraphExtractionDiagnostic]) -> bool {
    diagnostics.iter().any(|diagnostic| {
        diagnostic.severity == crate::protocol::GraphExtractionDiagnosticSeverity::Error
    })
}

pub(super) fn missing_metadata_freshness(max_age_ms: Option<u64>) -> FreshnessState {
    let generated_at = now_rfc3339();
    FreshnessState::Stale {
        metadata: None,
        freshness: stale_freshness(generated_at, 0, max_age_ms, "missing snapshot metadata"),
        reason: "graph store snapshot is missing".to_string(),
    }
}

pub(super) fn stale_metadata_freshness(
    metadata: GraphSnapshotMetadata,
    max_age_ms: Option<u64>,
    reason: impl Into<String>,
) -> FreshnessState {
    let age_ms = freshness_age_ms(&metadata.generated_at);
    stale_metadata_freshness_with_age(metadata, age_ms, max_age_ms, reason)
}

pub(super) fn stale_metadata_freshness_with_age(
    metadata: GraphSnapshotMetadata,
    age_ms: u64,
    max_age_ms: Option<u64>,
    reason: impl Into<String>,
) -> FreshnessState {
    let reason = reason.into();
    FreshnessState::Stale {
        freshness: stale_freshness(
            metadata.generated_at.clone(),
            age_ms,
            max_age_ms,
            reason.clone(),
        ),
        metadata: Some(metadata),
        reason,
    }
}

pub(super) fn hash_mismatch_reason(
    stored: &[SourceFileHash],
    current: &[SourceFileHash],
) -> Option<String> {
    let stored_by_path = stored
        .iter()
        .map(|hash| (hash.relative_path.as_str(), hash.sha256.as_str()))
        .collect::<BTreeMap<_, _>>();
    let current_by_path = current
        .iter()
        .map(|hash| (hash.relative_path.as_str(), hash.sha256.as_str()))
        .collect::<BTreeMap<_, _>>();
    for path in stored_by_path.keys() {
        if !current_by_path.contains_key(path) {
            return Some(format!("source file {path} was removed"));
        }
    }
    for (path, current_hash) in &current_by_path {
        match stored_by_path.get(path) {
            None => return Some(format!("source file {path} is new")),
            Some(stored_hash) if stored_hash != current_hash => {
                return Some(format!("source file {path} hash changed"));
            }
            Some(_) => {}
        }
    }
    None
}

pub(super) fn missing_watch_root_reason(
    repo_root: &Path,
    watch_paths: &[String],
) -> Option<String> {
    watch_paths.iter().find_map(|watch_path| {
        let candidate = repo_root.join(watch_path);
        (!candidate.exists()).then(|| format!("watch root {watch_path} is missing"))
    })
}

pub(super) fn scoped_source_hashes(
    hashes: Vec<SourceFileHash>,
    watch_paths: &[String],
) -> Vec<SourceFileHash> {
    if watch_paths.is_empty() {
        return hashes;
    }
    hashes
        .into_iter()
        .filter(|hash| path_in_watch_scope(&hash.relative_path, watch_paths))
        .collect()
}

fn path_in_watch_scope(relative_path: &str, watch_paths: &[String]) -> bool {
    watch_paths.iter().any(|watch_path| {
        relative_path == watch_path || relative_path.starts_with(&format!("{watch_path}/"))
    })
}

pub(super) fn stale_freshness(
    generated_at: String,
    age_ms: u64,
    max_age_ms: Option<u64>,
    reason: impl Into<String>,
) -> GraphFreshness {
    GraphFreshness {
        generated_at,
        age_ms,
        max_age_ms,
        stale: true,
        reason: Some(reason.into()),
    }
}

pub(super) fn freshness_age_ms(generated_at: &str) -> u64 {
    let Ok(generated) = OffsetDateTime::parse(generated_at, &Rfc3339) else {
        return 0;
    };
    let age = OffsetDateTime::now_utc() - generated;
    u64::try_from(age.whole_milliseconds().max(0)).unwrap_or(u64::MAX)
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| EXTRACTION_GENERATED_AT.to_string())
}

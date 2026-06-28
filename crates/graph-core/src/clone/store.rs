use super::{CloneClass, CloneError, CloneSource, CLONE_PROTOCOL, CLONE_STORE_SCHEMA_VERSION};
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

pub(super) fn persist_clone_index(
    repo_root: &Path,
    sources: &[CloneSource],
    classes: &[CloneClass],
) -> Result<PathBuf, CloneError> {
    let clone_dir = repo_root.join(".lattice").join("clone");
    std::fs::create_dir_all(&clone_dir)?;
    let db_path = clone_dir.join("clone.db");
    let mut connection = Connection::open(&db_path)?;
    initialize_clone_schema(&connection)?;
    let transaction = connection.transaction()?;
    transaction.execute("delete from clone_occurrences", [])?;
    transaction.execute("delete from clone_files", [])?;
    transaction.execute("delete from clone_metadata", [])?;
    transaction.execute(
        "insert into clone_metadata(key, value) values ('protocol', ?1)",
        params![CLONE_PROTOCOL],
    )?;
    transaction.execute(
        "insert into clone_metadata(key, value) values ('schema_version', ?1)",
        params![CLONE_STORE_SCHEMA_VERSION.to_string()],
    )?;
    for source in sources {
        transaction.execute(
            "insert into clone_files(path, language, sha256) values (?1, ?2, ?3)",
            params![source.path, source.language, source.sha256],
        )?;
    }
    for class in classes {
        for occurrence in &class.occurrences {
            transaction.execute(
                "insert into clone_occurrences(clone_class_id, content_hash, path, line_count, token_count) values (?1, ?2, ?3, ?4, ?5)",
                params![
                    class.clone_class_id,
                    class.content_hash,
                    occurrence.path,
                    class.line_count.to_string(),
                    class.token_count.to_string()
                ],
            )?;
        }
    }
    transaction.commit()?;
    Ok(db_path)
}

fn initialize_clone_schema(connection: &Connection) -> Result<(), CloneError> {
    connection.execute_batch(
        r#"
        pragma user_version = 1;
        create table if not exists clone_metadata (
          key text primary key,
          value text not null
        );
        create table if not exists clone_files (
          path text primary key,
          language text not null,
          sha256 text not null
        );
        create table if not exists clone_occurrences (
          clone_class_id text not null,
          content_hash text not null,
          path text not null,
          line_count integer not null,
          token_count integer not null
        );
        create index if not exists idx_clone_occurrences_class on clone_occurrences(clone_class_id);
        create index if not exists idx_clone_occurrences_path on clone_occurrences(path);
        "#,
    )?;
    Ok(())
}

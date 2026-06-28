use crate::protocol::{GraphFactEdge, GraphFactNode};

pub(super) fn read_node_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GraphFactNode> {
    if let Some(extra) = row.get::<_, Option<String>>(4)? {
        return parse_canonical_row(&extra, 4);
    }
    Ok(GraphFactNode {
        id: row.get(0)?,
        kind: row.get(1)?,
        path: row.get(2)?,
        name: row.get(3)?,
        attributes: None,
    })
}

pub(super) fn read_edge_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GraphFactEdge> {
    if let Some(extra) = row.get::<_, Option<String>>(4)? {
        return parse_canonical_row(&extra, 4);
    }
    Ok(GraphFactEdge {
        id: row.get(0)?,
        kind: row.get(1)?,
        from: row.get(2)?,
        to: row.get(3)?,
        attributes: None,
    })
}

fn parse_canonical_row<T: serde::de::DeserializeOwned>(
    extra: &str,
    column: usize,
) -> rusqlite::Result<T> {
    serde_json::from_str(extra).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

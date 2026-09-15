use tree_sitter::{Node, TreeCursor};

use crate::{
    analysis::AnalysisError,
    cancel::{CANCELLATION_POLL_INTERVAL, CancelToken},
};

#[derive(Clone, Copy)]
pub(super) enum WalkEvent<'tree> {
    Enter(Node<'tree>),
    Leave(Node<'tree>),
}

pub(super) fn walk<'tree>(
    root: Node<'tree>,
    cancel: &CancelToken,
    mut visitor: impl FnMut(WalkEvent<'tree>) -> Result<bool, AnalysisError>,
) -> Result<(), AnalysisError> {
    let mut cursor = root.walk();
    let mut visited = 0usize;
    loop {
        visited = visited.saturating_add(1);
        poll_cancel(visited, cancel)?;
        let node = cursor.node();
        let descend = visitor(WalkEvent::Enter(node))?;
        if descend_to_child(descend, &mut cursor) {
            continue;
        }
        let _ = visitor(WalkEvent::Leave(node))?;
        if cursor.goto_next_sibling() {
            continue;
        }
        if !ascend(&mut cursor, &mut visitor)? {
            return check_cancel(cancel);
        }
    }
}

fn descend_to_child(descend: bool, cursor: &mut TreeCursor<'_>) -> bool {
    descend && cursor.goto_first_child()
}

fn poll_cancel(visited: usize, cancel: &CancelToken) -> Result<(), AnalysisError> {
    if visited.is_multiple_of(CANCELLATION_POLL_INTERVAL) {
        check_cancel(cancel)
    } else {
        Ok(())
    }
}

fn ascend<'tree>(
    cursor: &mut TreeCursor<'tree>,
    visitor: &mut impl FnMut(WalkEvent<'tree>) -> Result<bool, AnalysisError>,
) -> Result<bool, AnalysisError> {
    loop {
        if !cursor.goto_parent() {
            return Ok(false);
        }
        let _ = visitor(WalkEvent::Leave(cursor.node()))?;
        if cursor.goto_next_sibling() {
            return Ok(true);
        }
    }
}

pub(super) fn walk_without_cancel(root: Node<'_>, mut visitor: impl FnMut(Node<'_>) -> bool) {
    let mut cursor = root.walk();
    loop {
        let descend = visitor(cursor.node());
        if descend && cursor.goto_first_child() {
            continue;
        }
        if cursor.goto_next_sibling() {
            continue;
        }
        if !ascend_without_events(&mut cursor) {
            return;
        }
    }
}

fn ascend_without_events(cursor: &mut TreeCursor<'_>) -> bool {
    loop {
        if !cursor.goto_parent() {
            return false;
        }
        if cursor.goto_next_sibling() {
            return true;
        }
    }
}

pub(super) fn check_cancel(cancel: &CancelToken) -> Result<(), AnalysisError> {
    if cancel.is_cancelled() {
        Err(AnalysisError::Cancelled)
    } else {
        Ok(())
    }
}

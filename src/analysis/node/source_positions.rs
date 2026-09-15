use crate::model::{Position, SourceRange};

#[derive(Debug)]
pub(super) struct LineIndex {
    starts: Vec<usize>,
    source_len: usize,
}

impl LineIndex {
    pub(super) fn new(source: &[u8]) -> Self {
        let mut starts = vec![0];
        starts.extend(
            source
                .iter()
                .enumerate()
                .filter(|(_, byte)| **byte == b'\n')
                .map(|(index, _)| index + 1),
        );
        Self {
            starts,
            source_len: source.len(),
        }
    }

    pub(super) fn position(&self, offset: usize) -> Position {
        let offset = offset.min(self.source_len);
        let line_index = self
            .starts
            .partition_point(|start| *start <= offset)
            .saturating_sub(1);
        Position {
            line: u32::try_from(line_index + 1).unwrap_or(u32::MAX),
            column: u32::try_from(offset.saturating_sub(self.starts[line_index]) + 1)
                .unwrap_or(u32::MAX),
            byte: u32::try_from(offset).unwrap_or(u32::MAX),
        }
    }

    pub(super) fn range(&self, start: usize, end: usize) -> SourceRange {
        SourceRange {
            start: self.position(start),
            end: self.position(end),
        }
    }
}

pub(super) fn byte_range(source: &[u8], start: usize, end: usize) -> SourceRange {
    LineIndex::new(source).range(start, end)
}

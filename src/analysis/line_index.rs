use crate::model::{Position, SourceRange};

pub(crate) struct LineIndex {
    starts: Vec<usize>,
    byte_base: usize,
}

impl LineIndex {
    pub(crate) fn new(source: &[u8], byte_base: usize) -> Self {
        let mut starts = Vec::with_capacity(source.len().saturating_div(32).saturating_add(1));
        starts.push(0);
        let mut index = 0usize;
        while index < source.len() {
            index = advance(source, index, &mut starts);
        }
        Self { starts, byte_base }
    }

    pub(crate) fn position(&self, byte: usize) -> Position {
        let line_index = self
            .starts
            .partition_point(|start| *start <= byte)
            .saturating_sub(1);
        let line_start = self.starts.get(line_index).copied().unwrap_or(0);
        Position {
            line: u32::try_from(line_index.saturating_add(1)).unwrap_or(u32::MAX),
            column: u32::try_from(byte.saturating_sub(line_start).saturating_add(1))
                .unwrap_or(u32::MAX),
            byte: u32::try_from(byte.saturating_add(self.byte_base)).unwrap_or(u32::MAX),
        }
    }

    pub(crate) fn byte_range(&self, start: usize, end: usize) -> SourceRange {
        SourceRange {
            start: self.position(start),
            end: self.position(end),
        }
    }

    pub(crate) fn line_span(&self, start: usize, end: usize) -> u32 {
        self.position(end)
            .line
            .saturating_sub(self.position(start).line)
            .saturating_add(1)
    }
}

fn advance(source: &[u8], index: usize, starts: &mut Vec<usize>) -> usize {
    let width = if source[index] == b'\r' && source.get(index + 1) == Some(&b'\n') {
        2
    } else if matches!(source[index], b'\r' | b'\n') {
        1
    } else {
        return index.saturating_add(1);
    };
    let next = index.saturating_add(width);
    starts.push(next);
    next
}

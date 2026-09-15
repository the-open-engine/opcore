use std::ops::Range;

use base64::Engine as _;

use crate::{
    limits::DEDUP_REGION_KGRAM_TOKENS,
    model::{Position, RegionFingerprintFacts, SourceFile},
};

const MIN_ENCODED_TOKEN_BYTES: usize = 11;

pub(super) struct DecodedTokens {
    pub(super) bytes: Vec<u8>,
    pub(super) tokens: Vec<DecodedToken>,
    line_starts: Vec<usize>,
}

impl DecodedTokens {
    pub(super) fn decode(source: &SourceFile, facts: &RegionFingerprintFacts) -> Option<Self> {
        Self::read(source, facts, true)
    }

    pub(super) fn validate(source: &SourceFile, facts: &RegionFingerprintFacts) -> bool {
        Self::read(source, facts, false).is_some()
    }

    fn read(source: &SourceFile, facts: &RegionFingerprintFacts, retain: bool) -> Option<Self> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&facts.encoded_tokens)
            .ok()?;
        let expected = usize::try_from(facts.token_count).ok()?;
        if expected > bytes.len() / MIN_ENCODED_TOKEN_BYTES {
            return None;
        }
        let tokens = decode_token_records(&bytes, source.bytes.len(), expected, retain)?;
        if !facts.anchors.iter().all(|anchor| {
            usize::try_from(anchor.token_index)
                .ok()
                .and_then(|start| start.checked_add(DEDUP_REGION_KGRAM_TOKENS))
                .is_some_and(|end| end <= expected)
        }) {
            return None;
        }
        let line_starts = if retain {
            collect_line_starts(&source.bytes)
        } else {
            Vec::new()
        };
        Some(Self {
            bytes: if retain { bytes } else { Vec::new() },
            tokens,
            line_starts,
        })
    }

    pub(super) fn position(&self, byte: usize) -> Position {
        let line = self
            .line_starts
            .partition_point(|start| *start <= byte)
            .saturating_sub(1);
        let line_start = self.line_starts.get(line).copied().unwrap_or(0);
        Position {
            line: u32::try_from(line).map_or(u32::MAX, |line| line.saturating_add(1)),
            column: u32::try_from(byte.saturating_sub(line_start).saturating_add(1))
                .unwrap_or(u32::MAX),
            byte: u32::try_from(byte).unwrap_or(u32::MAX),
        }
    }
}

fn decode_token_records(
    bytes: &[u8],
    source_len: usize,
    expected: usize,
    retain: bool,
) -> Option<Vec<DecodedToken>> {
    let mut tokens = if retain {
        Vec::with_capacity(expected)
    } else {
        Vec::new()
    };
    let mut decoded = 0usize;
    let mut cursor = 0usize;
    let mut previous_end = 0usize;
    while cursor < bytes.len() {
        let token = decode_token_record(bytes, source_len, &mut cursor)?;
        if token.start < previous_end {
            return None;
        }
        previous_end = token.end;
        decoded = decoded.saturating_add(1);
        if decoded > expected {
            return None;
        }
        if retain {
            tokens.push(token);
        }
    }
    (decoded == expected).then_some(tokens)
}

fn decode_token_record(
    bytes: &[u8],
    source_len: usize,
    cursor: &mut usize,
) -> Option<DecodedToken> {
    let start = usize::try_from(read_u32(bytes, cursor)?).ok()?;
    let end = usize::try_from(read_u32(bytes, cursor)?).ok()?;
    let tag = *bytes.get(*cursor)?;
    *cursor = cursor.saturating_add(1);
    let prefix_len = usize::from(read_u16(bytes, cursor)?);
    let prefix_start = *cursor;
    let prefix_end = cursor.checked_add(prefix_len)?;
    bytes.get(prefix_start..prefix_end)?;
    *cursor = prefix_end;
    (start < end && end <= source_len).then_some(DecodedToken {
        start,
        end,
        tag,
        prefix: prefix_start..prefix_end,
    })
}

fn collect_line_starts(source: &[u8]) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (index, byte) in source.iter().copied().enumerate() {
        if byte == b'\n' || (byte == b'\r' && source.get(index + 1) != Some(&b'\n')) {
            starts.push(index.saturating_add(1));
        }
    }
    starts
}

pub(super) struct DecodedToken {
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) tag: u8,
    pub(super) prefix: Range<usize>,
}

fn read_u32(bytes: &[u8], cursor: &mut usize) -> Option<u32> {
    let end = cursor.checked_add(4)?;
    let value = u32::from_be_bytes(bytes.get(*cursor..end)?.try_into().ok()?);
    *cursor = end;
    Some(value)
}

fn read_u16(bytes: &[u8], cursor: &mut usize) -> Option<u16> {
    let end = cursor.checked_add(2)?;
    let value = u16::from_be_bytes(bytes.get(*cursor..end)?.try_into().ok()?);
    *cursor = end;
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(bytes: &mut Vec<u8>, start: u32, end: u32) {
        bytes.extend_from_slice(&start.to_be_bytes());
        bytes.extend_from_slice(&end.to_be_bytes());
        bytes.push(0);
        bytes.extend_from_slice(&0u16.to_be_bytes());
    }

    #[test]
    fn token_records_must_be_in_source_order_without_overlap() {
        let mut reversed = Vec::new();
        record(&mut reversed, 8, 10);
        record(&mut reversed, 2, 4);
        assert!(decode_token_records(&reversed, 12, 2, false).is_none());

        let mut overlapping = Vec::new();
        record(&mut overlapping, 2, 8);
        record(&mut overlapping, 7, 10);
        assert!(decode_token_records(&overlapping, 12, 2, false).is_none());

        let mut adjacent = Vec::new();
        record(&mut adjacent, 2, 8);
        record(&mut adjacent, 8, 10);
        assert!(decode_token_records(&adjacent, 12, 2, false).is_some());
    }

    #[test]
    fn counted_token_records_must_cover_source_bytes() {
        let mut zero_width = Vec::new();
        record(&mut zero_width, 4, 4);
        assert!(decode_token_records(&zero_width, 12, 1, false).is_none());
    }
}

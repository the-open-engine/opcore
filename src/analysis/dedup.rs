use std::collections::VecDeque;

use base64::Engine as _;

use crate::{
    identity::hash_domain,
    limits::{
        DEDUP_REGION_KGRAM_TOKENS, DEDUP_REGION_WINNOW_SPAN, MAX_CALLABLE_FINGERPRINTS_PER_FILE,
        MAX_REGION_FINGERPRINTS_PER_FILE, MIN_DEDUP_CALLABLE_TOKENS,
    },
    model::{
        CallableFingerprint, CallableFingerprintFacts, CallableKind, FingerprintExtractionStatus,
        RegionFingerprint, RegionFingerprintFacts, SourceRange,
    },
};

const FINGERPRINT_DOMAIN: &str = "dedup-callable-body/v1";
const TOKEN_HASH_SEED_ONE: u64 = 0xa076_1d64_78bd_642f;
const TOKEN_HASH_SEED_TWO: u64 = 0xe703_7ed1_a0b4_28db;
const ROLLING_BASE_ONE: u64 = 0x9e37_79b1_85eb_ca87;
const ROLLING_BASE_TWO: u64 = 0xc2b2_ae3d_27d4_eb4f;

pub(crate) struct FingerprintToken<'a> {
    pub tag: u8,
    pub text: &'a [u8],
    pub line: u32,
    pub counted: bool,
    pub start_byte: u32,
    pub end_byte: u32,
}

pub(crate) fn fingerprint<'a>(
    language_domain: &str,
    kind: CallableKind,
    range: SourceRange,
    tokens: impl IntoIterator<Item = FingerprintToken<'a>>,
) -> Option<CallableFingerprint> {
    let mut encoded = Vec::new();
    let mut token_count = 0usize;
    let mut token_line_count = 0usize;
    let mut prior_line = None;
    for token in tokens {
        if token.counted {
            token_count = token_count.saturating_add(1);
            if prior_line != Some(token.line) {
                token_line_count = token_line_count.saturating_add(1);
                prior_line = Some(token.line);
            }
        }
        encoded.push(token.tag);
        encoded.extend_from_slice(
            &u32::try_from(token.text.len())
                .unwrap_or(u32::MAX)
                .to_be_bytes(),
        );
        encoded.extend_from_slice(token.text);
    }
    if token_count < MIN_DEDUP_CALLABLE_TOKENS {
        return None;
    }
    Some(CallableFingerprint {
        kind,
        range,
        token_count: u32::try_from(token_count).unwrap_or(u32::MAX),
        token_line_count: u32::try_from(token_line_count).unwrap_or(u32::MAX),
        digest: hex::encode(hash_domain(
            FINGERPRINT_DOMAIN,
            &[language_domain.as_bytes(), &encoded],
        )),
    })
}

#[derive(Default)]
pub(crate) struct FingerprintCollector {
    callables: Vec<CallableFingerprint>,
    truncated: bool,
}

impl FingerprintCollector {
    pub(crate) fn push(&mut self, fingerprint: Option<CallableFingerprint>) {
        let Some(fingerprint) = fingerprint else {
            return;
        };
        if self.callables.len() >= MAX_CALLABLE_FINGERPRINTS_PER_FILE {
            self.truncated = true;
            return;
        }
        self.callables.push(fingerprint);
    }

    pub(crate) fn finish(mut self) -> CallableFingerprintFacts {
        self.callables.sort();
        CallableFingerprintFacts {
            status: if self.truncated {
                FingerprintExtractionStatus::Truncated
            } else {
                FingerprintExtractionStatus::Complete
            },
            callables: self.callables,
        }
    }
}

pub(crate) fn parser_failed() -> CallableFingerprintFacts {
    CallableFingerprintFacts {
        status: FingerprintExtractionStatus::ParserFailed,
        callables: Vec::new(),
    }
}

pub(crate) fn region_parser_failed() -> RegionFingerprintFacts {
    RegionFingerprintFacts {
        status: FingerprintExtractionStatus::ParserFailed,
        ..RegionFingerprintFacts::default()
    }
}

pub(crate) fn region_fingerprints<'a>(
    language_domain: &str,
    tokens: impl IntoIterator<Item = FingerprintToken<'a>>,
) -> RegionFingerprintFacts {
    let mut encoded = Vec::new();
    let mut pending = Vec::new();
    let mut token_count = 0usize;
    let mut winnower = Winnower::default();
    for token in tokens {
        if !token.counted {
            encode_component(&mut pending, token.tag, token.text);
            if pending.len() > u16::MAX as usize {
                return truncated_regions();
            }
            continue;
        }
        if token.end_byte < token.start_byte {
            return truncated_regions();
        }
        let Ok(prefix_len) = u16::try_from(pending.len()) else {
            return truncated_regions();
        };
        encoded.extend_from_slice(&token.start_byte.to_be_bytes());
        encoded.extend_from_slice(&token.end_byte.to_be_bytes());
        encoded.push(token.tag);
        encoded.extend_from_slice(&prefix_len.to_be_bytes());
        encoded.extend_from_slice(&pending);
        let token_hash = normalized_token_hash(language_domain, &pending, &token);
        pending.clear();
        if !winnower.push(token_hash) {
            return truncated_regions();
        }
        token_count = token_count.saturating_add(1);
    }
    RegionFingerprintFacts {
        status: FingerprintExtractionStatus::Complete,
        token_count: u32::try_from(token_count).unwrap_or(u32::MAX),
        encoded_tokens: base64::engine::general_purpose::STANDARD.encode(encoded),
        anchors: winnower.anchors,
    }
}

fn truncated_regions() -> RegionFingerprintFacts {
    RegionFingerprintFacts {
        status: FingerprintExtractionStatus::Truncated,
        ..RegionFingerprintFacts::default()
    }
}

fn encode_component(output: &mut Vec<u8>, tag: u8, text: &[u8]) {
    output.push(tag);
    output.extend_from_slice(&u32::try_from(text.len()).unwrap_or(u32::MAX).to_be_bytes());
    output.extend_from_slice(text);
}

fn normalized_token_hash(
    language_domain: &str,
    prefix: &[u8],
    token: &FingerprintToken<'_>,
) -> (u64, u64) {
    let mut one = TOKEN_HASH_SEED_ONE;
    let mut two = TOKEN_HASH_SEED_TWO;
    hash_bytes(&mut one, language_domain.as_bytes(), ROLLING_BASE_ONE);
    hash_bytes(&mut two, language_domain.as_bytes(), ROLLING_BASE_TWO);
    hash_bytes(&mut one, prefix, ROLLING_BASE_ONE);
    hash_bytes(&mut two, prefix, ROLLING_BASE_TWO);
    one = one.wrapping_mul(ROLLING_BASE_ONE) ^ u64::from(token.tag);
    two = two.wrapping_mul(ROLLING_BASE_TWO) ^ u64::from(token.tag);
    hash_bytes(&mut one, token.text, ROLLING_BASE_ONE);
    hash_bytes(&mut two, token.text, ROLLING_BASE_TWO);
    (mix(one), mix(two))
}

fn hash_bytes(state: &mut u64, bytes: &[u8], base: u64) {
    *state = state.wrapping_mul(base).wrapping_add(bytes.len() as u64);
    for byte in bytes {
        *state = state.wrapping_mul(base).wrapping_add(u64::from(*byte));
    }
}

#[derive(Default)]
struct Winnower {
    token_window: VecDeque<(u64, u64)>,
    minima: VecDeque<(usize, (u64, u64))>,
    hash_one: u64,
    hash_two: u64,
    kgram_count: usize,
    previous_selection: Option<usize>,
    anchors: Vec<RegionFingerprint>,
}

impl Winnower {
    fn push(&mut self, token: (u64, u64)) -> bool {
        if self.token_window.len() < DEDUP_REGION_KGRAM_TOKENS {
            self.hash_one = self
                .hash_one
                .wrapping_mul(ROLLING_BASE_ONE)
                .wrapping_add(token.0);
            self.hash_two = self
                .hash_two
                .wrapping_mul(ROLLING_BASE_TWO)
                .wrapping_add(token.1);
            self.token_window.push_back(token);
            if self.token_window.len() < DEDUP_REGION_KGRAM_TOKENS {
                return true;
            }
        } else {
            let Some(previous) = self.token_window.pop_front() else {
                return false;
            };
            self.token_window.push_back(token);
            self.hash_one = self
                .hash_one
                .wrapping_mul(ROLLING_BASE_ONE)
                .wrapping_add(token.0)
                .wrapping_sub(
                    previous
                        .0
                        .wrapping_mul(wrapping_power(ROLLING_BASE_ONE, DEDUP_REGION_KGRAM_TOKENS)),
                );
            self.hash_two = self
                .hash_two
                .wrapping_mul(ROLLING_BASE_TWO)
                .wrapping_add(token.1)
                .wrapping_sub(
                    previous
                        .1
                        .wrapping_mul(wrapping_power(ROLLING_BASE_TWO, DEDUP_REGION_KGRAM_TOKENS)),
                );
        }
        self.observe_kgram()
    }

    fn observe_kgram(&mut self) -> bool {
        let index = self.kgram_count;
        self.kgram_count = self.kgram_count.saturating_add(1);
        let hash = (self.hash_one, self.hash_two);
        while self.minima.back().is_some_and(|(_, prior)| *prior >= hash) {
            self.minima.pop_back();
        }
        self.minima.push_back((index, hash));
        while self
            .minima
            .front()
            .is_some_and(|(prior, _)| prior.saturating_add(DEDUP_REGION_WINNOW_SPAN) <= index)
        {
            self.minima.pop_front();
        }
        if index + 1 < DEDUP_REGION_WINNOW_SPAN {
            return true;
        }
        let Some(&(selected, selected_hash)) = self.minima.front() else {
            return false;
        };
        if self.previous_selection == Some(selected) {
            return true;
        }
        self.previous_selection = Some(selected);
        if self.anchors.len() >= MAX_REGION_FINGERPRINTS_PER_FILE {
            return false;
        }
        self.anchors.push(RegionFingerprint {
            hash_one: selected_hash.0,
            hash_two: selected_hash.1,
            token_index: u32::try_from(selected).unwrap_or(u32::MAX),
        });
        true
    }
}

const fn wrapping_power(base: u64, exponent: usize) -> u64 {
    let mut result = 1u64;
    let mut index = 0usize;
    while index < exponent {
        result = result.wrapping_mul(base);
        index += 1;
    }
    result
}

const fn mix(mut value: u64) -> u64 {
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Position;

    fn counted_token(index: usize, text: &str) -> FingerprintToken<'_> {
        FingerprintToken {
            tag: 0,
            text: text.as_bytes(),
            line: 1,
            counted: true,
            start_byte: u32::try_from(index).unwrap(),
            end_byte: u32::try_from(index + 1).unwrap(),
        }
    }

    fn region_facts(texts: &[String]) -> RegionFingerprintFacts {
        region_fingerprints(
            "node",
            texts
                .iter()
                .enumerate()
                .map(|(index, text)| counted_token(index, text)),
        )
    }

    fn range() -> SourceRange {
        let position = Position {
            line: 1,
            column: 1,
            byte: 0,
        };
        SourceRange {
            start: position,
            end: position,
        }
    }

    #[test]
    fn threshold_and_language_domain_are_part_of_fingerprint_semantics() {
        let texts = (0..MIN_DEDUP_CALLABLE_TOKENS)
            .map(|index| format!("token{index}"))
            .collect::<Vec<_>>();
        let make = |domain| {
            fingerprint(
                domain,
                CallableKind::Function,
                range(),
                texts
                    .iter()
                    .enumerate()
                    .map(|(index, text)| FingerprintToken {
                        tag: 0,
                        text: text.as_bytes(),
                        line: u32::try_from(index).unwrap(),
                        counted: true,
                        start_byte: u32::try_from(index).unwrap(),
                        end_byte: u32::try_from(index + 1).unwrap(),
                    }),
            )
            .unwrap()
        };
        assert_ne!(make("node").digest, make("python").digest);
        assert!(fingerprint("node", CallableKind::Function, range(), []).is_none());
    }

    #[test]
    fn per_file_collector_is_bounded_and_marks_truncation() {
        let fingerprint = CallableFingerprint {
            kind: CallableKind::Function,
            range: range(),
            token_count: 48,
            token_line_count: 1,
            digest: "00".repeat(32),
        };
        let mut collector = FingerprintCollector::default();
        for _ in 0..=MAX_CALLABLE_FINGERPRINTS_PER_FILE {
            collector.push(Some(fingerprint.clone()));
        }
        let facts = collector.finish();
        assert_eq!(facts.status, FingerprintExtractionStatus::Truncated);
        assert_eq!(facts.callables.len(), MAX_CALLABLE_FINGERPRINTS_PER_FILE);
    }

    #[test]
    fn winnowing_retains_an_anchor_for_every_guaranteed_match_offset() {
        let shared = (0..crate::limits::MIN_DEDUP_REGION_TOKENS)
            .map(|index| format!("shared_{index}"))
            .collect::<Vec<_>>();
        for offset in 0..128usize {
            let left_prefix = offset % 31;
            let right_prefix = offset.saturating_mul(7) % 31;
            let make = |prefix: usize, base: usize| {
                (0..prefix)
                    .map(|index| format!("prefix_{base}_{index}"))
                    .chain(shared.iter().cloned())
                    .collect::<Vec<_>>()
            };
            let left_texts = make(left_prefix, offset);
            let right_texts = make(right_prefix, offset + 1_000);
            let left = region_facts(&left_texts);
            let right = region_facts(&right_texts);
            assert!(left.anchors.iter().any(|anchor| {
                right.anchors.iter().any(|candidate| {
                    anchor.hash_one == candidate.hash_one && anchor.hash_two == candidate.hash_two
                })
            }));
        }
    }

    #[test]
    fn repetitive_stream_hits_the_per_file_bound_without_partial_facts() {
        let text = "same";
        let facts = region_fingerprints(
            "node",
            (0..5_000usize).map(|index| counted_token(index, text)),
        );
        assert_eq!(facts.status, FingerprintExtractionStatus::Truncated);
        assert_eq!(facts.token_count, 0);
        assert!(facts.encoded_tokens.is_empty());
        assert!(facts.anchors.is_empty());
    }

    #[test]
    fn anchors_begin_at_the_exact_guaranteed_match_threshold() {
        let make = |count: usize| {
            let texts = (0..count)
                .map(|index| format!("token_{index}"))
                .collect::<Vec<_>>();
            let facts = region_facts(&texts);
            (texts, facts)
        };
        let (_, below) = make(crate::limits::MIN_DEDUP_REGION_TOKENS - 1);
        let (_, exact) = make(crate::limits::MIN_DEDUP_REGION_TOKENS);
        assert!(below.anchors.is_empty());
        assert_eq!(exact.anchors.len(), 1);
    }
}

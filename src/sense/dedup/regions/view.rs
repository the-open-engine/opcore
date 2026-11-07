use super::{
    AnchorOccurrence, Arc, BTreeMap, BTreeSet, ComparisonState, DecodedTokens, EvidenceState,
    ExactToken, FingerprintExtractionStatus, MAX_REGION_FINGERPRINTS_PER_FILE, Range,
    RegionCoverage, RegionFile, RegionView, RegionViewInputs, SourceFile, SourceRange,
    TokenLocation, batches, hash_domain, lookup_file_fact, record_bounded_path,
};

impl<'a> RegionView<'a> {
    pub(super) fn new(inputs: &RegionViewInputs<'a, '_>) -> Self {
        let mut view = Self {
            view: inputs.view,
            files: Vec::new(),
            groups: BTreeMap::new(),
            retained_anchors: 0,
            retained_tokens: 0,
            decoded_evidence: inputs.decoded_evidence.clone(),
            #[cfg(test)]
            indexed: 0,
            malformed_paths: BTreeSet::new(),
            malformed_paths_truncated: false,
        };
        for source in inputs.snapshot.files() {
            view.add_file(source, inputs);
        }
        view
    }

    fn add_file(&mut self, source: &'a SourceFile, inputs: &RegionViewInputs<'a, '_>) {
        let Some((key, facts)) = lookup_file_fact(source, inputs.file_facts, inputs.fact_keys)
        else {
            return;
        };
        let region = &facts.region_fingerprints;
        if region.status != FingerprintExtractionStatus::Complete {
            return;
        }
        let path = inputs
            .continuity
            .get(&source.path)
            .cloned()
            .unwrap_or_else(|| source.path.clone());
        let state = self
            .decoded_evidence
            .borrow_mut()
            .state(key, source, region, false);
        if matches!(state, EvidenceState::Malformed) {
            record_bounded_path(
                &mut self.malformed_paths,
                &mut self.malformed_paths_truncated,
                path,
            );
            return;
        }
        if region.anchors.len() > MAX_REGION_FINGERPRINTS_PER_FILE {
            return;
        }
        let Some(anchor_order) = self.decoded_evidence.borrow_mut().anchor_order(key, region)
        else {
            record_bounded_path(
                &mut self.malformed_paths,
                &mut self.malformed_paths_truncated,
                path,
            );
            return;
        };
        self.retained_anchors = self.retained_anchors.saturating_add(region.anchors.len());
        self.retained_tokens = self
            .retained_tokens
            .saturating_add(usize::try_from(region.token_count).unwrap_or(usize::MAX));
        self.files.push(RegionFile {
            source,
            path,
            fact_key: key,
            facts: Arc::clone(&inputs.file_facts[&key]),
            anchor_order,
        });
    }

    pub(super) fn index_batch(&mut self, selection: &batches::Selection) {
        self.groups.clear();
        for (file_index, (file, range)) in self.files.iter().zip(&selection.ranges).enumerate() {
            for index in &file.anchor_order[range.clone()] {
                let anchor = &file.facts.region_fingerprints.anchors[usize::from(*index)];
                self.groups
                    .entry(file.source.language.family())
                    .or_default()
                    .entry((anchor.hash_one, anchor.hash_two))
                    .or_default()
                    .push(AnchorOccurrence {
                        file: file_index,
                        token_index: anchor.token_index,
                    });
                #[cfg(test)]
                {
                    self.indexed += 1;
                }
            }
        }
        for occurrences in self.groups.values_mut().flat_map(BTreeMap::values_mut) {
            occurrences.sort_by(|left, right| {
                (&self.files[left.file].path, left.token_index)
                    .cmp(&(&self.files[right.file].path, right.token_index))
            });
        }
    }

    pub(super) fn coverage(&self, comparison: &ComparisonState) -> RegionCoverage {
        RegionCoverage {
            anchors: self.retained_anchors,
            tokens: self.retained_tokens,
            request_truncated: (comparison.limit_reached || comparison.decode_processed.is_some())
                && comparison.views.contains(&self.view),
            malformed_evidence: !self.malformed_paths.is_empty()
                || self.malformed_paths_truncated
                || (comparison.malformed_evidence && comparison.views.contains(&self.view)),
        }
    }

    pub(super) fn tokens(&self, file: usize) -> Option<Arc<DecodedTokens>> {
        let file = self.files.get(file)?;
        self.decoded_evidence
            .borrow_mut()
            .state(
                file.fact_key,
                file.source,
                &file.facts.region_fingerprints,
                true,
            )
            .decoded()
    }

    pub(super) fn exact_token<'token>(
        &'token self,
        location: TokenLocation,
        decoded: &'token DecodedTokens,
    ) -> Option<ExactToken<'token>> {
        let file = self.files.get(location.file)?;
        let token = decoded.tokens.get(location.token)?;
        Some(ExactToken {
            tag: token.tag,
            prefix: decoded.bytes.get(token.prefix.clone())?,
            text: file.source.bytes.get(token.start..token.end)?,
        })
    }

    pub(super) fn region_range(&self, file: usize, range: Range<usize>) -> Option<SourceRange> {
        self.tokens(file)?.source_range(range)
    }

    pub(super) fn region_digest(&self, file: usize, range: Range<usize>) -> Option<String> {
        let decoded = self.tokens(file)?;
        let file = self.files.get(file)?;
        let mut encoded = Vec::new();
        for token in decoded.tokens.get(range)? {
            let prefix = decoded.bytes.get(token.prefix.clone())?;
            encoded.extend_from_slice(
                &u32::try_from(prefix.len())
                    .unwrap_or(u32::MAX)
                    .to_be_bytes(),
            );
            encoded.extend_from_slice(prefix);
            encoded.push(token.tag);
            let text = file.source.bytes.get(token.start..token.end)?;
            encoded.extend_from_slice(&u32::try_from(text.len()).unwrap_or(u32::MAX).to_be_bytes());
            encoded.extend_from_slice(text);
        }
        Some(hex::encode(hash_domain(
            "dedup-token-region/v1",
            &[file.source.language.family().as_bytes(), &encoded],
        )))
    }
}

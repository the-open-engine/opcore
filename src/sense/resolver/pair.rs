use std::collections::BTreeSet;

use crate::{facts, model::Language, path::RepoPath, source::snapshot::SourceSnapshot};

use super::{
    Projection, ResolutionContext, ResolutionIndex, project_with_index, rust,
    update_changed_importers,
};

#[derive(Clone, Copy)]
pub(crate) struct PairInput<'a> {
    pub(crate) before: &'a SourceSnapshot,
    pub(crate) after: &'a SourceSnapshot,
    pub(crate) file_facts: &'a facts::FactMap,
    pub(crate) parser_options: &'a [u8],
    pub(crate) interface_paths: &'a BTreeSet<RepoPath>,
    pub(crate) go_modules: &'a super::super::engine::GoModuleViews,
}

pub(crate) fn project_pair(input: PairInput<'_>) -> (Projection, Projection, BTreeSet<RepoPath>) {
    let before_index = ResolutionIndex::new(
        input.before,
        input.file_facts,
        input.parser_options,
        &input.go_modules.before,
    );
    let metadata_changed = input.go_modules.before != input.go_modules.after;
    let before_interface_paths =
        interface_paths(&before_index, input.interface_paths, metadata_changed);
    let before_projection = project_with_index(
        input.before,
        &context(&input, &before_index, &before_interface_paths),
    );
    if views_match(&input) {
        return (
            before_projection.clone(),
            before_projection,
            before_interface_paths,
        );
    }
    project_changed(
        input,
        &before_index,
        &before_interface_paths,
        before_projection,
        metadata_changed,
    )
}

fn project_changed(
    input: PairInput<'_>,
    before_index: &ResolutionIndex,
    before_interface_paths: &BTreeSet<RepoPath>,
    before_projection: Projection,
    metadata_changed: bool,
) -> (Projection, Projection, BTreeSet<RepoPath>) {
    let incremental_safe = incremental_safe(&input, before_index);
    let after_index = (!incremental_safe).then(|| {
        ResolutionIndex::new(
            input.after,
            input.file_facts,
            input.parser_options,
            &input.go_modules.after,
        )
    });
    let comparison_index = after_index.as_ref().unwrap_or(before_index);
    let after_interface_paths =
        interface_paths(comparison_index, input.interface_paths, metadata_changed);
    let logical_changed_paths = before_interface_paths
        .union(&after_interface_paths)
        .cloned()
        .collect();
    let resolution_context = context(&input, comparison_index, &after_interface_paths);
    let after_projection = if full_projection_required(incremental_safe, &before_projection) {
        project_with_index(input.after, &resolution_context)
    } else {
        update_changed_importers(
            input.before,
            input.after,
            before_projection.clone(),
            &resolution_context,
            &after_interface_paths,
        )
    };
    (before_projection, after_projection, logical_changed_paths)
}

fn context<'a>(
    input: &PairInput<'a>,
    index: &'a ResolutionIndex,
    interface_paths: &'a BTreeSet<RepoPath>,
) -> ResolutionContext<'a> {
    ResolutionContext {
        file_facts: input.file_facts,
        parser_options: input.parser_options,
        index,
        interface_paths,
    }
}

fn views_match(input: &PairInput<'_>) -> bool {
    input.before.id() == input.after.id() && input.go_modules.before == input.go_modules.after
}

fn incremental_safe(input: &PairInput<'_>, before_index: &ResolutionIndex) -> bool {
    can_incrementally_project(input.before, input.after, input.interface_paths)
        && rust::index_is_stable(input.before, input.after, input.interface_paths)
        && !go_sensitive(input, before_index)
}

fn go_sensitive(input: &PairInput<'_>, before_index: &ResolutionIndex) -> bool {
    before_index.go.has_go()
        || input
            .after
            .files()
            .any(|file| file.language == Language::Go)
        || !input.go_modules.before.is_empty()
        || !input.go_modules.after.is_empty()
}

fn full_projection_required(incremental_safe: bool, before: &Projection) -> bool {
    !incremental_safe
        || before.coverage.edges_truncated
        || !before.resolution_gaps.is_empty()
        || before.resolution_gaps_truncated
        || before.interface_coverage.selectors_truncated
}

fn interface_paths(
    index: &ResolutionIndex,
    paths: &BTreeSet<RepoPath>,
    metadata_changed: bool,
) -> BTreeSet<RepoPath> {
    let mut logical = paths
        .iter()
        .map(|path| index.go.logical_path_for(path))
        .collect::<BTreeSet<_>>();
    if metadata_changed {
        logical.extend(index.go.logical_paths().cloned());
    }
    logical
}

pub(super) fn can_incrementally_project(
    before: &SourceSnapshot,
    after: &SourceSnapshot,
    changed_paths: &BTreeSet<RepoPath>,
) -> bool {
    before.len() == after.len()
        && before.files().zip(after.files()).all(|(before, after)| {
            before.path == after.path
                && before.language == after.language
                && (before.content_id == after.content_id || changed_paths.contains(&before.path))
        })
}

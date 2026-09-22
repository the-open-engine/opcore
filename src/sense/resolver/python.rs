use crate::{
    model::{DependencyReference, DependencyReferenceKind},
    path::RepoPath,
};

use super::{Resolution, ResolutionIndex, alias_resolution, normalized_relative};

pub(super) fn resolve(
    importer: &RepoPath,
    reference: &DependencyReference,
    index: &ResolutionIndex,
) -> Resolution {
    let absolute = reference.kind == DependencyReferenceKind::PythonAbsolute;
    let Some(base) = normalized(importer, &reference.specifier, reference.level) else {
        return if absolute {
            Resolution::Ambiguous
        } else {
            Resolution::Unresolved
        };
    };
    match alias_resolution(index.python_aliases.get(&base)) {
        Resolution::Unresolved if absolute => Resolution::Ambiguous,
        resolution => resolution,
    }
}

fn normalized(importer: &RepoPath, module: &str, level: u32) -> Option<String> {
    if module.is_empty() || module.contains(['/', '\\']) {
        return None;
    }
    if level == 0 {
        if module.contains('.') {
            return None;
        }
        return normalized_relative(importer, module, 0);
    }
    let parents = usize::try_from(level.saturating_sub(1)).ok()?;
    let module_path = module.replace('.', "/");
    normalized_relative(importer, &module_path, parents)
}

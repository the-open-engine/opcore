use crate::model::DependencyReferenceKind;

use super::{EdgeKind, ResolutionGapKind};

#[derive(Clone, Copy)]
pub(super) enum ReferenceClass {
    Edge(EdgeKind),
    Unsupported,
    Unresolved,
}

impl ReferenceClass {
    pub(super) const fn gap_kind(self) -> Option<ResolutionGapKind> {
        match self {
            Self::Edge(_) => None,
            Self::Unsupported => Some(ResolutionGapKind::UnsupportedDynamic),
            Self::Unresolved => Some(ResolutionGapKind::Unresolved),
        }
    }
}

pub(super) const fn reference_class(kind: DependencyReferenceKind) -> ReferenceClass {
    match kind {
        DependencyReferenceKind::NodeRuntime
        | DependencyReferenceKind::PythonRelative
        | DependencyReferenceKind::PythonAbsolute
        | DependencyReferenceKind::GoImport => ReferenceClass::Edge(EdgeKind::Runtime),
        DependencyReferenceKind::NodeType => ReferenceClass::Edge(EdgeKind::TypeOnly),
        DependencyReferenceKind::RustModule | DependencyReferenceKind::RustUse => {
            ReferenceClass::Edge(EdgeKind::Structural)
        }
        DependencyReferenceKind::NodeUnsupportedDynamic
        | DependencyReferenceKind::RustUnsupported
        | DependencyReferenceKind::GoUnsupportedImport
        | DependencyReferenceKind::GoUnsupportedConditional => ReferenceClass::Unsupported,
        DependencyReferenceKind::PythonUnsupportedRelative => ReferenceClass::Unresolved,
    }
}

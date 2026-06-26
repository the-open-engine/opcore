use crate::protocol::{
    GraphExtractionDiagnostic, GraphExtractionDiagnosticCategory, GraphExtractionDiagnosticSeverity,
};

pub fn error(
    category: GraphExtractionDiagnosticCategory,
    message: impl Into<String>,
    path: Option<String>,
    language: Option<String>,
) -> GraphExtractionDiagnostic {
    diagnostic(
        category,
        GraphExtractionDiagnosticSeverity::Error,
        message,
        DiagnosticLocation { path, language },
    )
}

pub fn warning(
    category: GraphExtractionDiagnosticCategory,
    message: impl Into<String>,
    path: Option<String>,
    language: Option<String>,
) -> GraphExtractionDiagnostic {
    diagnostic(
        category,
        GraphExtractionDiagnosticSeverity::Warning,
        message,
        DiagnosticLocation { path, language },
    )
}

pub fn info(
    category: GraphExtractionDiagnosticCategory,
    message: impl Into<String>,
    path: Option<String>,
    language: Option<String>,
) -> GraphExtractionDiagnostic {
    diagnostic(
        category,
        GraphExtractionDiagnosticSeverity::Info,
        message,
        DiagnosticLocation { path, language },
    )
}

pub fn has_error(diagnostics: &[GraphExtractionDiagnostic]) -> bool {
    diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == GraphExtractionDiagnosticSeverity::Error)
}

struct DiagnosticLocation {
    path: Option<String>,
    language: Option<String>,
}

fn diagnostic(
    category: GraphExtractionDiagnosticCategory,
    severity: GraphExtractionDiagnosticSeverity,
    message: impl Into<String>,
    location: DiagnosticLocation,
) -> GraphExtractionDiagnostic {
    GraphExtractionDiagnostic {
        category,
        severity,
        message: message.into(),
        path: location.path,
        language: location.language,
    }
}

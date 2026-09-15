use tree_sitter::Node;

use crate::{
    analysis::{
        AnalysisError, PROTOBUF_PARSER_VERSION, invalid_utf8_diagnostic, line_index::LineIndex,
        parser_evidence, parser_failure_facts, preflight::bounded_structure,
        source_without_utf8_bom,
    },
    cancel::CancelToken,
    limits::MAX_STRUCTURAL_DEPTH,
    model::{FileFacts, Language, RawDiagnostic, Severity, SourceFile},
};

const PARSER: &str = "tree-sitter-proto";

/// Parses one Protocol Buffers source file without resolving imports or invoking `protoc`.
pub(crate) fn analyze(file: &SourceFile, cancel: &CancelToken) -> Result<FileFacts, AnalysisError> {
    if file.language != Language::Protobuf || file.language_mode != "protobuf:proto" {
        return Err(AnalysisError::Unsupported(format!(
            "unsupported Protobuf language mode '{}'",
            file.language_mode
        )));
    }
    let (source, byte_base) = source_without_utf8_bom(&file.bytes);
    let lines = LineIndex::new(source, byte_base);
    let text = match std::str::from_utf8(source) {
        Ok(text) => text,
        Err(error) => {
            return Ok(parser_failure_facts(
                PARSER,
                PROTOBUF_PARSER_VERSION,
                vec![invalid_utf8_diagnostic(super::InvalidUtf8Diagnostic {
                    language: "Protobuf",
                    rule_id: "protobuf.syntax",
                    source,
                    lines: &lines,
                    error,
                    evidence: parser_evidence(PARSER, PROTOBUF_PARSER_VERSION),
                })],
            ));
        }
    };
    analyze_text(source, text, &lines, cancel)
}

fn analyze_text(
    source: &[u8],
    text: &str,
    lines: &LineIndex,
    cancel: &CancelToken,
) -> Result<FileFacts, AnalysisError> {
    bounded_structure(source, "Protobuf", MAX_STRUCTURAL_DEPTH, cancel)?;
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&tree_sitter_proto::LANGUAGE.into())
        .map_err(|error| AnalysisError::Parser(format!("initialize Protobuf parser: {error}")))?;
    let tree = parser
        .parse(text, None)
        .ok_or_else(|| AnalysisError::Parser("Protobuf parser returned no tree".into()))?;
    if cancel.is_cancelled() {
        return Err(AnalysisError::Cancelled);
    }
    let diagnostics = first_syntax_error(tree.root_node(), source, lines, cancel)?
        .into_iter()
        .collect::<Vec<_>>();
    Ok(facts(diagnostics))
}

fn facts(diagnostics: Vec<RawDiagnostic>) -> FileFacts {
    if diagnostics.is_empty() {
        FileFacts {
            parser: PARSER.into(),
            parser_version: PROTOBUF_PARSER_VERSION.into(),
            ..FileFacts::default()
        }
    } else {
        parser_failure_facts(PARSER, PROTOBUF_PARSER_VERSION, diagnostics)
    }
}

fn first_syntax_error(
    root: Node<'_>,
    source: &[u8],
    lines: &LineIndex,
    cancel: &CancelToken,
) -> Result<Option<RawDiagnostic>, AnalysisError> {
    let mut stack = vec![root];
    let mut visited = 0_usize;
    while let Some(node) = stack.pop() {
        visited = visited.saturating_add(1);
        if visited.is_multiple_of(crate::cancel::CANCELLATION_POLL_INTERVAL)
            && cancel.is_cancelled()
        {
            return Err(AnalysisError::Cancelled);
        }
        if node.is_error() || node.is_missing() {
            let start = node.start_byte().min(source.len());
            let end = node
                .end_byte()
                .max(start.saturating_add(1))
                .min(source.len());
            let kind = if node.is_missing() {
                "missing"
            } else {
                "syntax"
            };
            let mut evidence = parser_evidence(PARSER, PROTOBUF_PARSER_VERSION);
            evidence.insert("errorKind".into(), serde_json::json!(kind));
            evidence.insert("nodeKind".into(), serde_json::json!(node.kind()));
            return Ok(Some(RawDiagnostic {
                rule_id: "protobuf.syntax".into(),
                severity: Severity::Error,
                message: format!("Invalid Protobuf syntax near {}", node.kind()),
                range: Some(lines.byte_range(start, end)),
                entity_key: format!(
                    "syntax:{kind}:{}",
                    crate::analysis::line_anchor(source, start)
                ),
                cause_key: format!("parser:{PROTOBUF_PARSER_VERSION}:{kind}"),
                evidence,
            }));
        }
        for index in (0..node.child_count()).rev() {
            if let Some(child) = u32::try_from(index)
                .ok()
                .and_then(|index| node.child(index))
            {
                stack.push(child);
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path::RepoPath;

    fn source(text: &str) -> SourceFile {
        SourceFile::new(
            RepoPath::from_protocol("schema.proto").unwrap(),
            text.as_bytes(),
            Language::Protobuf,
            "protobuf:proto".into(),
        )
    }

    #[test]
    fn accepts_proto2_proto3_and_edition_syntax() {
        for text in [
            "syntax = \"proto2\"; message A { optional string value = 1; }",
            "syntax = \"proto3\"; service API { rpc Get(A) returns (A); } message A {}",
            "edition = \"2023\"; package example; message A { string value = 1; }",
        ] {
            let facts = analyze(&source(text), &CancelToken::new()).unwrap();
            assert!(facts.diagnostics.is_empty(), "{text:?}");
        }
    }

    #[test]
    fn reports_invalid_syntax_and_utf8() {
        let facts = analyze(
            &source("syntax = \"proto3\"; message Broken { string value = ; }"),
            &CancelToken::new(),
        )
        .unwrap();
        assert_eq!(facts.diagnostics[0].rule_id, "protobuf.syntax");

        let invalid = SourceFile::new(
            RepoPath::from_protocol("bad.proto").unwrap(),
            b"syntax = \"proto3\";\xff".as_slice(),
            Language::Protobuf,
            "protobuf:proto".into(),
        );
        assert_eq!(
            analyze(&invalid, &CancelToken::new()).unwrap().diagnostics[0].cause_key,
            "invalid_utf8"
        );
    }
}

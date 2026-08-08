use super::support::*;
use crate::extraction::{discover_sources_for_options, extract_sources, ExtractionOptions};
use crate::protocol::{
    GraphExtractionDiagnosticCategory as Category, GraphExtractionDiagnosticSeverity as Severity,
};
use serde_json::{json, Value};

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[cfg(test)]
pub(super) struct PythonTests;

#[test]
fn python_ast_extracts_contract_facts() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write_python_graph_fixture(&repo)?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));
    let node_ids = sorted(result.nodes.iter().map(|node| node.id.clone()).collect());
    let triples = edge_triples(&result.edges);

    assert!(
        !result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == Severity::Error),
        "{:?}",
        result.diagnostics
    );
    for id in [
        "file:src/pkg/models.py",
        "module:src/pkg/models.py#src.pkg.models",
        "class:src/pkg/models.py#PublicModel",
        "function:src/pkg/models.py#PublicModel.from_value",
        "function:src/pkg/models.py#make_model",
        "function:src/pkg/models.py#_hidden",
        "variable:src/pkg/models.py#_private",
        "function:tests/test_models.py#test_make_model",
        "function:tests/test_models.py#TestPublicModel.test_render",
    ] {
        assert!(node_ids.contains(&id.to_string()), "{id}");
    }
    for triple in [
        vec![
            "CONTAINS".to_string(),
            "file:src/pkg/models.py".to_string(),
            "module:src/pkg/models.py#src.pkg.models".to_string(),
        ],
        vec![
            "CONTAINS".to_string(),
            "module:src/pkg/models.py#src.pkg.models".to_string(),
            "class:src/pkg/models.py#PublicModel".to_string(),
        ],
        vec![
            "CONTAINS".to_string(),
            "class:src/pkg/models.py#PublicModel".to_string(),
            "function:src/pkg/models.py#PublicModel.from_value".to_string(),
        ],
        vec![
            "CALLS".to_string(),
            "function:src/pkg/models.py#make_model".to_string(),
            "class:src/pkg/models.py#PublicModel".to_string(),
        ],
        vec![
            "INHERITS".to_string(),
            "class:src/pkg/models.py#PublicModel".to_string(),
            "class:src/pkg/base.py#BaseModel".to_string(),
        ],
        vec![
            "TESTED_BY".to_string(),
            "class:src/pkg/models.py#PublicModel".to_string(),
            "function:tests/test_models.py#test_make_model".to_string(),
        ],
    ] {
        assert!(triples.contains(&triple), "{triple:?}");
    }
    assert!(result.metadata.node_kinds.contains(&"Module".to_string()));
    Ok(())
}

#[test]
fn python_import_resolution_handles_absolute_relative_package_and_unresolved() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write_python_graph_fixture(&repo)?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));
    let triples = edge_triples(&result.edges);

    for triple in [
        vec![
            "IMPORTS_FROM".to_string(),
            "file:src/pkg/models.py".to_string(),
            "file:src/pkg/base.py".to_string(),
        ],
        vec![
            "IMPORTS_FROM".to_string(),
            "file:src/pkg/models.py".to_string(),
            "file:src/pkg/helpers.py".to_string(),
        ],
        vec![
            "IMPORTS_FROM".to_string(),
            "file:tests/test_models.py".to_string(),
            "file:src/pkg/models.py".to_string(),
        ],
        vec![
            "IMPORTS_FROM".to_string(),
            "file:tests/test_models.py".to_string(),
            "file:src/pkg/__init__.py".to_string(),
        ],
        vec![
            "IMPORTS_FROM".to_string(),
            "file:src/pkg/uses_stub.py".to_string(),
            "file:src/pkg/stubs.pyi".to_string(),
        ],
    ] {
        assert!(triples.contains(&triple), "{triple:?}");
    }
    assert!(result.diagnostics.iter().any(|diagnostic| {
        diagnostic.category == Category::UnresolvedImport
            && diagnostic.severity == Severity::Warning
            && diagnostic.path.as_deref() == Some("src/pkg/models.py")
    }));
    assert!(!result
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error));
    Ok(())
}

#[test]
fn python_exports_are_best_effort_and_documented() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write_python_graph_fixture(&repo)?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));

    assert_eq!(
        required_attributes(&result.nodes, "class:src/pkg/models.py#PublicModel")?,
        json!({
            "decorators": [],
            "exportKind": "named",
            "exportName": "PublicModel",
            "exportPolicy": "__all__",
            "exported": true,
            "isTest": false
        })
    );
    assert_eq!(
        required_attributes(&result.nodes, "function:src/pkg/models.py#_hidden")?,
        json!({
            "async": false,
            "decorators": [],
            "exportPolicy": "__all__",
            "exported": false,
            "isTest": false
        })
    );
    assert_eq!(
        required_attributes(&result.nodes, "function:src/pkg/helpers.py#build_name")?,
        json!({
            "async": false,
            "decorators": [],
            "exportKind": "named",
            "exportName": "build_name",
            "exportPolicy": "underscore_convention",
            "exported": true,
            "isTest": false
        })
    );
    let exports = required_exports(&result.nodes, "file:src/pkg/models.py")?;
    for expected in [
        json!({
            "kind": "named",
            "local": "PublicModel",
            "exported": "PublicModel",
            "source": null,
            "supportedSymbol": true,
            "policy": "__all__"
        }),
        json!({
            "kind": "named",
            "local": "make_model",
            "exported": "make_model",
            "source": null,
            "supportedSymbol": true,
            "policy": "__all__"
        }),
    ] {
        assert!(exports.contains(&expected), "{expected}");
    }
    Ok(())
}

#[test]
fn python_module_level_all_wins_even_when_empty() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(
        &repo,
        "pkg/api.py",
        r#"
__all__ = []

def exposed():
    return True

class Public:
    pass
"#,
    )?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));

    assert_eq!(
        required_attributes(&result.nodes, "function:pkg/api.py#exposed")?,
        json!({"async":false,"decorators":[],"exportPolicy":"__all__","exported":false,"isTest":false})
    );
    assert_eq!(
        required_attributes(&result.nodes, "class:pkg/api.py#Public")?,
        json!({"decorators":[],"exportPolicy":"__all__","exported":false,"isTest":false})
    );
    assert_eq!(
        required_exports(&result.nodes, "file:pkg/api.py")?,
        Vec::<Value>::new()
    );
    Ok(())
}

#[test]
fn python_nested_all_does_not_control_module_exports() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(
        &repo,
        "pkg/api.py",
        r#"
def leaked():
    __all__ = ["_hidden"]
    return True

def _hidden():
    return True
"#,
    )?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));

    assert_eq!(
        required_attributes(&result.nodes, "function:pkg/api.py#leaked")?,
        json!({
            "async": false,
            "decorators": [],
            "exportKind": "named",
            "exportName": "leaked",
            "exportPolicy": "underscore_convention",
            "exported": true,
            "isTest": false
        })
    );
    assert_eq!(
        required_attributes(&result.nodes, "function:pkg/api.py#_hidden")?,
        json!({
            "async": false,
            "decorators": [],
            "exportPolicy": "underscore_convention",
            "exported": false,
            "isTest": false
        })
    );
    assert_eq!(
        required_exports(&result.nodes, "file:pkg/api.py")?,
        vec![json!({
            "kind": "named",
            "local": "leaked",
            "exported": "leaked",
            "source": null,
            "supportedSymbol": true,
            "policy": "underscore_convention"
        })]
    );
    Ok(())
}

#[test]
fn python_dotted_import_module_calls_resolve_to_exported_member() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(
        &repo,
        "pkg/sub.py",
        r#"
def target():
    return True
"#,
    )?;
    write(
        &repo,
        "app.py",
        r#"
import pkg.sub

def run():
    return pkg.sub.target()
"#,
    )?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));
    let triples = edge_triples(&result.edges);

    assert!(triples.contains(&vec![
        "IMPORTS_FROM".to_string(),
        "file:app.py".to_string(),
        "file:pkg/sub.py".to_string()
    ]));
    assert!(triples.contains(&vec![
        "CALLS".to_string(),
        "function:app.py#run".to_string(),
        "function:pkg/sub.py#target".to_string()
    ]));
    Ok(())
}

#[test]
fn python_package_from_import_submodule_calls_resolve_to_submodule_member() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(&repo, "pkg/__init__.py", "")?;
    write(
        &repo,
        "pkg/mod.py",
        r#"
def f():
    return True
"#,
    )?;
    write(
        &repo,
        "app.py",
        r#"
from pkg import mod

def g():
    return mod.f()
"#,
    )?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));
    let triples = edge_triples(&result.edges);

    assert!(triples.contains(&vec![
        "IMPORTS_FROM".to_string(),
        "file:app.py".to_string(),
        "file:pkg/mod.py".to_string()
    ]));
    assert!(triples.contains(&vec![
        "CALLS".to_string(),
        "function:app.py#g".to_string(),
        "function:pkg/mod.py#f".to_string()
    ]));
    Ok(())
}

#[test]
fn python_parse_errors_are_typed_warnings_and_non_fatal() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(&repo, "src/broken.py", "def broken(:\n    return True\n")?;

    let result = extract_sources(ExtractionOptions::new(repo.path()));

    assert!(result.diagnostics.iter().any(|diagnostic| {
        diagnostic.category == Category::ParseError && diagnostic.severity == Severity::Warning
    }));
    assert!(!result
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error));
    assert!(result
        .nodes
        .iter()
        .any(|node| node.id == "file:src/broken.py"));
    Ok(())
}

#[test]
fn python_sources_are_discovered_and_extracted() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(&repo, "src/app.ts", "export const app = true;\n")?;
    write(&repo, "src/tool.py", "def run():\n    return True\n")?;
    write(&repo, "src/typings.pyi", "def run() -> bool: ...\n")?;

    let discovery = discover_sources_for_options(&ExtractionOptions::new(repo.path()));
    let sources = discovery
        .sources
        .iter()
        .map(|source| (source.relative_path.as_str(), source.language.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        sources,
        vec![
            ("src/app.ts", "typescript"),
            ("src/tool.py", "python"),
            ("src/typings.pyi", "python")
        ]
    );
    assert!(!discovery
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.category == Category::UnsupportedLanguage));

    let result = extract_sources(ExtractionOptions::new(repo.path()));
    assert!(!result
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error));
    assert_eq!(
        sorted(
            result
                .file_hashes
                .iter()
                .map(|hash| format!("{}:{}", hash.relative_path, hash.language))
                .collect()
        ),
        vec![
            "src/app.ts:typescript".to_string(),
            "src/tool.py:python".to_string(),
            "src/typings.pyi:python".to_string()
        ]
    );
    assert!(result
        .nodes
        .iter()
        .any(|node| node.id == "file:src/tool.py"));
    assert!(result
        .nodes
        .iter()
        .any(|node| node.id == "file:src/typings.pyi"));
    Ok(())
}

#[test]
fn python_generated_private_and_dependency_paths_are_ignored() -> TestResult {
    let repo = repo_with_tsconfig()?;
    write(&repo, "src/app.ts", "export const app = true;\n")?;
    write(&repo, "src/tool.py", "def run():\n    return True\n")?;
    for path in [
        ".venv/lib/python3.12/site-packages/pkg/ignored.py",
        "venv/lib/python3.12/site-packages/pkg/ignored.py",
        "env/lib/python3.12/site-packages/pkg/ignored.py",
        ".agents/runtime/ignored.ts",
        ".claude/runtime/ignored.ts",
        ".codex/runtime/ignored.ts",
        ".gemini/runtime/ignored.ts",
        ".opencode/runtime/ignored.ts",
        "src/__pycache__/ignored.py",
        ".eggs/pkg/ignored.py",
        "build/lib/ignored.py",
        ".tox/py/ignored.py",
        ".mypy_cache/ignored.py",
        ".pytest_cache/ignored.py",
        ".ruff_cache/ignored.py",
        "pkg.egg-info/ignored.py",
        "pkg.dist-info/ignored.py",
        "lib/site-packages/pkg/ignored.py",
    ] {
        write(&repo, path, "def ignored():\n    return True\n")?;
    }

    let discovery = discover_sources_for_options(&ExtractionOptions::new(repo.path()));
    let source_paths = sorted(
        discovery
            .sources
            .iter()
            .map(|source| source.relative_path.clone())
            .collect(),
    );

    assert_eq!(source_paths, vec!["src/app.ts", "src/tool.py"]);
    assert!(!discovery
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.category == Category::UnsupportedLanguage));
    Ok(())
}

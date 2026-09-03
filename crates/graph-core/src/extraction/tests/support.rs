use crate::extraction::ExtractionResult;
use crate::protocol::{
    GraphExtractionDiagnosticCategory as Category, GraphExtractionDiagnosticSeverity as Severity,
    GraphFactNode,
};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tempfile::TempDir;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[cfg(test)]
pub(super) fn assert_error_category(result: ExtractionResult, category: Category) {
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.category == category
                && diagnostic.severity == Severity::Error),
        "{:?}",
        result.diagnostics
    );
    assert!(result.nodes.is_empty());
    assert!(result.edges.is_empty());
}

#[cfg(test)]
pub(super) fn wave1_fixture_root() -> Result<PathBuf, std::io::Error> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/fixtures/source-extraction/wave1")
        .canonicalize()
}

#[cfg(test)]
pub(super) fn temp_repo() -> Result<TempDir, std::io::Error> {
    tempfile::tempdir()
}

#[cfg(test)]
pub(super) fn repo_with_tsconfig() -> Result<TempDir, std::io::Error> {
    let repo = temp_repo()?;
    write(
        &repo,
        "tsconfig.json",
        r#"{"compilerOptions":{"baseUrl":"."}}"#,
    )?;
    Ok(repo)
}

#[cfg(test)]
pub(super) fn write_python_graph_fixture(repo: &TempDir) -> TestResult {
    write_python_package_files(repo)?;
    write_python_model_files(repo)?;
    write_python_stub_and_tests(repo)?;
    Ok(())
}

#[cfg(test)]
pub(super) fn write_rust_graph_fixture(repo: &TempDir) -> TestResult {
    write(
        repo,
        "src/lib.rs",
        r#"
pub mod helpers;
mod user;

pub trait Service {
    fn handle(&self);
}

pub struct Widget;

pub enum Mode {
    Fast,
}

impl Service for Widget {
    fn handle(&self) {
        helpers::assist();
    }
}

pub type Alias = Widget;
pub const LIMIT: usize = 1;
pub static NAME: &str = "widget";

macro_rules! trace {
    () => {};
}
"#,
    )?;
    write(repo, "src/helpers.rs", "pub fn assist() -> usize { 1 }\n")?;
    write(
        repo,
        "src/user.rs",
        r#"
use crate::helpers;
use crate::{Service, Widget};

pub fn run() {
    helpers::assist();
    let widget = Widget;
    widget.handle();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_run() {
        run();
    }
}
"#,
    )?;
    Ok(())
}

fn write_python_package_files(repo: &TempDir) -> TestResult {
    write(
        repo,
        "src/pkg/__init__.py",
        r#"
from .models import PublicModel

PACKAGE_VALUE = PublicModel()
__all__ = ["PublicModel", "PACKAGE_VALUE"]
"#,
    )?;
    write(
        repo,
        "src/pkg/base.py",
        r#"
class BaseModel:
    pass
"#,
    )?;
    write(
        repo,
        "src/pkg/helpers.py",
        r#"
def build_name():
    return "public"
	"#,
    )?;
    Ok(())
}

fn write_python_model_files(repo: &TempDir) -> TestResult {
    write(
        repo,
        "src/pkg/models.py",
        r#"
from .base import BaseModel
from .helpers import build_name
from .missing import MissingLocal

_private = 1
__all__ = ["PublicModel", "make_model"]

class PublicModel(BaseModel):
    @classmethod
    def from_value(cls):
        return build_name()

    def render(self):
        return build_name()

def make_model():
    return PublicModel()

def _hidden():
    return PublicModel()
	"#,
    )?;
    Ok(())
}

fn write_python_stub_and_tests(repo: &TempDir) -> TestResult {
    write(repo, "src/pkg/stubs.pyi", "def stubbed() -> str: ...\n")?;
    write(
        repo,
        "src/pkg/uses_stub.py",
        r#"
from .stubs import stubbed

def call_stub():
    return stubbed()
"#,
    )?;
    write(
        repo,
        "tests/test_models.py",
        r#"
from src.pkg import PACKAGE_VALUE
from src.pkg.models import PublicModel, make_model

def test_make_model():
    make_model()
    PublicModel.from_value()
    return PACKAGE_VALUE

class TestPublicModel:
    def test_render(self):
        return PublicModel().render()
"#,
    )?;
    Ok(())
}

#[cfg(test)]
pub(super) fn write(repo: &TempDir, path: &str, contents: &str) -> Result<(), std::io::Error> {
    let path = repo.path().join(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)
}

#[cfg(test)]
pub(super) fn edge_triples(edges: &[crate::protocol::GraphFactEdge]) -> Vec<Vec<String>> {
    sorted(
        edges
            .iter()
            .map(|edge| vec![edge.kind.clone(), edge.from.clone(), edge.to.clone()])
            .collect(),
    )
}

#[cfg(test)]
pub(super) fn value_strings(value: &Value, key: &str) -> Result<Vec<String>, std::io::Error> {
    let entries = value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| std::io::Error::other(format!("missing string array {key}")))?;
    entries
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .map(ToString::to_string)
                .ok_or_else(|| std::io::Error::other(format!("non-string entry in {key}")))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(sorted)
}

#[cfg(test)]
pub(super) fn value_triples(value: &Value, key: &str) -> Result<Vec<Vec<String>>, std::io::Error> {
    let entries = value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| std::io::Error::other(format!("missing triple array {key}")))?;
    entries
        .iter()
        .map(|entry| {
            let parts = entry
                .as_array()
                .ok_or_else(|| std::io::Error::other(format!("non-array triple in {key}")))?;
            parts
                .iter()
                .map(|part| {
                    part.as_str().map(ToString::to_string).ok_or_else(|| {
                        std::io::Error::other(format!("non-string triple part in {key}"))
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()
        .map(sorted)
}

#[cfg(test)]
pub(super) fn value_object(value: &Value, key: &str) -> Result<Value, std::io::Error> {
    value
        .get(key)
        .cloned()
        .ok_or_else(|| std::io::Error::other(format!("missing object {key}")))
}

#[cfg(test)]
pub(super) fn node_attributes(nodes: &[GraphFactNode]) -> Value {
    let mut attributes = serde_json::Map::new();
    for node in nodes {
        if node.kind == "File" {
            continue;
        }
        attributes.insert(
            node.id.clone(),
            node.attributes.clone().unwrap_or_else(|| json!({})),
        );
    }
    Value::Object(attributes)
}

#[cfg(test)]
pub(super) fn file_exports(nodes: &[GraphFactNode]) -> Value {
    let mut exports_by_file = serde_json::Map::new();
    for node in nodes {
        if node.kind != "File" {
            continue;
        }
        if let Some(exports) = node
            .attributes
            .as_ref()
            .and_then(|attributes| attributes.get("exports"))
        {
            exports_by_file.insert(node.id.clone(), exports.clone());
        }
    }
    Value::Object(exports_by_file)
}

#[cfg(test)]
pub(super) fn required_attributes(
    nodes: &[GraphFactNode],
    id: &str,
) -> Result<Value, std::io::Error> {
    let node = nodes
        .iter()
        .find(|node| node.id == id)
        .ok_or_else(|| std::io::Error::other(format!("missing node {id}")))?;
    node.attributes
        .clone()
        .ok_or_else(|| std::io::Error::other(format!("missing attributes for {id}")))
}

#[cfg(test)]
pub(super) fn required_exports(
    nodes: &[GraphFactNode],
    id: &str,
) -> Result<Vec<Value>, std::io::Error> {
    let node = nodes
        .iter()
        .find(|node| node.id == id)
        .ok_or_else(|| std::io::Error::other(format!("missing node {id}")))?;
    node.attributes
        .as_ref()
        .and_then(|attributes| attributes.get("exports"))
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| std::io::Error::other(format!("missing exports for {id}")))
}

#[cfg(test)]
pub(super) fn assert_missing_node(nodes: &[GraphFactNode], id: &str) -> Result<(), std::io::Error> {
    if nodes.iter().any(|node| node.id == id) {
        Err(std::io::Error::other(format!("unexpected node {id}")))
    } else {
        Ok(())
    }
}

#[cfg(test)]
pub(super) fn sorted<T: Ord>(mut values: Vec<T>) -> Vec<T> {
    values.sort();
    values
}

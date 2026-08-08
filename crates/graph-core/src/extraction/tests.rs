mod diagnostics;
mod python;
mod rust;
mod support;
mod typescript_exports;
mod typescript_resolution;

use diagnostics::DiagnosticsTests;
use python::PythonTests;
use rust::RustTests;
use typescript_exports::TypeScriptExportTests;
use typescript_resolution::TypeScriptResolutionTests;

type SplitTestModules = (
    DiagnosticsTests,
    PythonTests,
    RustTests,
    TypeScriptExportTests,
    TypeScriptResolutionTests,
);

const _: usize = std::mem::size_of::<SplitTestModules>();

use crate::{model::Language, path::RepoPath};

// Every suffix we recognize as code belongs to Check's coverage envelope even when no parser is
// available. This lets Check report unsupported coverage instead of silently dropping a file;
// Sense reuses the same source envelope and adds its own metadata candidates separately.
const UNSUPPORTED_SOURCE_EXTENSIONS: &[&[u8]] = &[
    b".adb",
    b".ads",
    b".asm",
    b".bat",
    b".bzl",
    b".c",
    b".cc",
    b".cbl",
    b".clj",
    b".cljc",
    b".cljs",
    b".cmd",
    b".cob",
    b".cpp",
    b".cr",
    b".cs",
    b".cxx",
    b".d",
    b".dart",
    b".erl",
    b".ex",
    b".exs",
    b".f",
    b".f90",
    b".f95",
    b".fish",
    b".fs",
    b".fsx",
    b".gradle",
    b".graphql",
    b".groovy",
    b".h",
    b".hpp",
    b".hrl",
    b".hs",
    b".java",
    b".jl",
    b".kt",
    b".kts",
    b".lua",
    b".m",
    b".ml",
    b".mli",
    b".mm",
    b".move",
    b".nim",
    b".pas",
    b".php",
    b".pl",
    b".pm",
    b".ps1",
    b".psm1",
    b".pxd",
    b".pxi",
    b".pyx",
    b".qml",
    b".r",
    b".raku",
    b".rb",
    b".s",
    b".scala",
    b".sol",
    b".sql",
    b".svelte",
    b".swift",
    b".tcl",
    b".thrift",
    b".vb",
    b".vue",
    b".wat",
    b".zig",
    b".zsh",
];

#[must_use]
pub fn detect_language(path: &RepoPath) -> Option<(Language, String)> {
    path.as_utf8()?;
    language_rule(path.as_bytes()).map(|(language, mode)| {
        let mode = match language {
            Language::Shell => format!("{mode}:{}", std::env::consts::OS),
            Language::Go => format!("{mode}:{}:{}", go_target_os(), go_target_arch()),
            _ => mode.into(),
        };
        (language, mode)
    })
}

#[must_use]
pub fn resolve_language(path: &RepoPath, bytes: &[u8]) -> Option<(Language, String)> {
    let (language, mode) = detect_language(path)?;
    if language != Language::Shell {
        return Some((language, mode));
    }
    let dialect = shell_shebang_dialect(bytes).unwrap_or_else(|| {
        if has_extension(path.as_bytes(), b".bash") {
            "bash"
        } else {
            "sh"
        }
    });
    Some((
        language,
        format!("shell:{dialect}:{}", std::env::consts::OS),
    ))
}

#[must_use]
pub fn is_source_candidate(path: &RepoPath) -> bool {
    if language_rule(path.as_bytes()).is_some() {
        return true;
    }
    UNSUPPORTED_SOURCE_EXTENSIONS
        .iter()
        .any(|extension| has_extension(path.as_bytes(), extension))
}

#[must_use]
pub(crate) fn is_dependency_source_candidate(path: &RepoPath) -> bool {
    is_source_candidate(path)
}

#[must_use]
pub(crate) fn is_dependency_capture_candidate(path: &RepoPath) -> bool {
    is_dependency_source_candidate(path) || is_go_module_file(path)
}

#[must_use]
pub(crate) fn is_go_module_file(path: &RepoPath) -> bool {
    path.as_bytes()
        .rsplit(|byte| *byte == b'/')
        .next()
        .is_some_and(|filename| filename == b"go.mod")
}

fn language_rule(path: &[u8]) -> Option<(Language, &'static str)> {
    let filename = path.rsplit(|byte| *byte == b'/').next().unwrap_or(path);
    if filename.eq_ignore_ascii_case(b".terraform.lock.hcl") {
        return Some((Language::Hcl, "hcl:terraform-lock:native"));
    }
    for (name, mode) in [
        (b"terragrunt.hcl".as_slice(), "hcl:terragrunt:native"),
        (b"terragrunt.hcl.json".as_slice(), "hcl:terragrunt:json"),
        (
            b"terragrunt.stack.hcl".as_slice(),
            "hcl:terragrunt-stack:native",
        ),
        (
            b"terragrunt.values.hcl".as_slice(),
            "hcl:terragrunt-values:native",
        ),
    ] {
        if filename.eq_ignore_ascii_case(name) {
            return Some((Language::Hcl, mode));
        }
    }
    if has_tfvars_suffix(filename) {
        let mode = if has_extension(filename, b".json") {
            "hcl:terraform-vars:json"
        } else {
            "hcl:terraform-vars:native"
        };
        return Some((Language::Hcl, mode));
    }
    language_rules()
        .iter()
        .find(|(suffix, _, _)| has_extension(path, suffix.as_bytes()))
        .map(|(_, language, mode)| (*language, *mode))
}

pub(crate) fn strip_language_suffix(path: &str, language: Language) -> Option<&str> {
    language_rules()
        .iter()
        .find(|(suffix, candidate, _)| {
            *candidate == language && has_extension(path.as_bytes(), suffix.as_bytes())
        })
        .map(|(suffix, _, _)| &path[..path.len() - suffix.len()])
}

pub(crate) fn has_extension(path: &[u8], extension: &[u8]) -> bool {
    path.len() >= extension.len()
        && path[path.len() - extension.len()..].eq_ignore_ascii_case(extension)
}

fn has_tfvars_suffix(filename: &[u8]) -> bool {
    filename
        .windows(b".tfvars".len())
        .position(|window| window.eq_ignore_ascii_case(b".tfvars"))
        .is_some_and(|index| {
            let remainder = &filename[index + b".tfvars".len()..];
            remainder.is_empty() || remainder.starts_with(b".")
        })
}

fn shell_shebang_dialect(bytes: &[u8]) -> Option<&'static str> {
    let line_end = bytes
        .iter()
        .position(|byte| matches!(byte, b'\r' | b'\n'))
        .unwrap_or(bytes.len());
    let command = bytes.get(..line_end)?.strip_prefix(b"#!")?;
    let mut words = command
        .split(u8::is_ascii_whitespace)
        .filter(|word| !word.is_empty());
    let interpreter = shell_command_name(words.next()?)?;
    if interpreter == b"env" {
        env_shell_dialect(&mut words)
    } else {
        known_shell_dialect(interpreter)
    }
}

fn env_shell_dialect<'a>(words: &mut impl Iterator<Item = &'a [u8]>) -> Option<&'static str> {
    while let Some(word) = words.next() {
        if env_option_takes_value(word) {
            words.next()?;
            continue;
        }
        if env_option_without_value(word) || env_assignment(word) {
            continue;
        }
        if word.starts_with(b"-") {
            return None;
        }
        return known_shell_dialect(shell_command_name(word)?);
    }
    None
}

fn env_option_takes_value(word: &[u8]) -> bool {
    matches!(word, b"-u" | b"--unset")
}

fn env_option_without_value(word: &[u8]) -> bool {
    matches!(
        word,
        b"-S" | b"--split-string" | b"-i" | b"--ignore-environment" | b"--"
    ) || word.starts_with(b"--unset=")
}

fn env_assignment(word: &[u8]) -> bool {
    word.contains(&b'=')
}

fn known_shell_dialect(interpreter: &[u8]) -> Option<&'static str> {
    match interpreter {
        b"bash" => Some("bash"),
        b"sh" | b"dash" => Some("sh"),
        _ => None,
    }
}

fn shell_command_name(word: &[u8]) -> Option<&[u8]> {
    let name = word.rsplit(|byte| matches!(byte, b'/' | b'\\')).next()?;
    (!name.is_empty()).then_some(name)
}

fn language_rules() -> &'static [(&'static str, Language, &'static str)] {
    &[
        (
            ".d.mts",
            Language::TypeScript,
            "typescript:declaration:module",
        ),
        (
            ".d.cts",
            Language::TypeScript,
            "typescript:declaration:commonjs",
        ),
        (".d.ts", Language::TypeScript, "typescript:declaration"),
        (".tsx", Language::TypeScript, "typescript:tsx"),
        (".mts", Language::TypeScript, "typescript:module"),
        (".cts", Language::TypeScript, "typescript:commonjs"),
        (".ts", Language::TypeScript, "typescript"),
        (".jsx", Language::JavaScript, "javascript:jsx"),
        (".mjs", Language::JavaScript, "javascript:module"),
        (".cjs", Language::JavaScript, "javascript:commonjs"),
        (".js", Language::JavaScript, "javascript:unambiguous"),
        (".rs", Language::Rust, "rust:stable"),
        ("_test.go", Language::Go, "go:test"),
        (".go", Language::Go, "go:source"),
        (".pyi", Language::Python, "python:stub:bundled-grammar"),
        (".py", Language::Python, "python:bundled-grammar"),
        (".tftest.json", Language::Hcl, "hcl:terraform-test:json"),
        (".tofutest.json", Language::Hcl, "hcl:opentofu-test:json"),
        (".tftest.hcl", Language::Hcl, "hcl:terraform-test:native"),
        (".tofutest.hcl", Language::Hcl, "hcl:opentofu-test:native"),
        (".tf.json", Language::Hcl, "hcl:terraform:json"),
        (".tofu.json", Language::Hcl, "hcl:opentofu:json"),
        (".tf", Language::Hcl, "hcl:terraform:native"),
        (".tofu", Language::Hcl, "hcl:opentofu:native"),
        (".hcl", Language::Hcl, "hcl:generic:native"),
        (".bash", Language::Shell, "shell:bash"),
        (".sh", Language::Shell, "shell:sh"),
        (".proto", Language::Protobuf, "protobuf:proto"),
    ]
}

fn go_target_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        value => value,
    }
}

fn go_target_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "x86" => "386",
        value => value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_supported_unsupported_and_non_source_suffixes() {
        for path in [
            "a.js",
            "a.jsx",
            "a.mjs",
            "a.cjs",
            "a.ts",
            "a.tsx",
            "a.mts",
            "a.cts",
            "a.d.ts",
            "a.d.mts",
            "a.d.cts",
            "a.rs",
            "a.go",
            "a_test.go",
            "a.py",
            "a.pyi",
            "main.tf",
            "main.tofu",
            "vars.tfvars",
            "module.tftest.hcl",
            "terragrunt.hcl",
            "generic.hcl",
            "script.sh",
            "script.bash",
            "schema.proto",
        ] {
            assert!(
                detect_language(&RepoPath::from_protocol(path).unwrap()).is_some(),
                "{path}"
            );
        }
        let go = RepoPath::from_protocol("a.go").unwrap();
        assert_eq!(detect_language(&go).unwrap().0, Language::Go);
        assert!(is_source_candidate(&go));
        assert!(is_dependency_source_candidate(
            &RepoPath::from_protocol("script.sh").unwrap()
        ));
        assert!(is_source_candidate(
            &RepoPath::from_protocol("script.sh").unwrap()
        ));
        let protobuf = RepoPath::from_protocol("schema.proto").unwrap();
        assert_eq!(detect_language(&protobuf).unwrap().0, Language::Protobuf);
        for path in ["src/Main.java", "src/main.zig"] {
            let path = RepoPath::from_protocol(path).unwrap();
            assert_eq!(detect_language(&path), None);
            assert!(is_source_candidate(&path));
            assert!(is_dependency_source_candidate(&path));
        }
        assert!(!is_source_candidate(
            &RepoPath::from_protocol("README.md").unwrap()
        ));
        assert!(!is_dependency_source_candidate(
            &RepoPath::from_protocol("README.md").unwrap()
        ));
        let go_module = RepoPath::from_protocol("nested/go.mod").unwrap();
        assert!(is_dependency_capture_candidate(&go_module));
        assert!(!is_dependency_source_candidate(&go_module));
        assert!(is_go_module_file(&go_module));

        let mixed_case = RepoPath::from_protocol("SRC/COMPONENT.D.TS").unwrap();
        assert_eq!(
            detect_language(&mixed_case),
            Some((Language::TypeScript, "typescript:declaration".into()))
        );
        let non_utf8 = RepoPath::new(b"src/\xffmodule.RS".to_vec()).unwrap();
        assert_eq!(detect_language(&non_utf8), None);
        assert!(is_source_candidate(&non_utf8));

        assert_eq!(
            strip_language_suffix("src/COMPONENT.D.TS", Language::TypeScript),
            Some("src/COMPONENT")
        );
    }

    #[test]
    fn classifies_iac_flavors_and_json_forms() {
        for (path, mode) in [
            ("main.tf", "hcl:terraform:native"),
            ("main.tf.json", "hcl:terraform:json"),
            ("main.tofu", "hcl:opentofu:native"),
            ("main.tofu.json", "hcl:opentofu:json"),
            ("terraform.tfvars.example", "hcl:terraform-vars:native"),
            ("prod.auto.tfvars.json", "hcl:terraform-vars:json"),
            ("module.tftest.hcl", "hcl:terraform-test:native"),
            ("module.tofutest.json", "hcl:opentofu-test:json"),
            (".terraform.lock.hcl", "hcl:terraform-lock:native"),
            ("terragrunt.hcl", "hcl:terragrunt:native"),
            ("terragrunt.hcl.json", "hcl:terragrunt:json"),
            ("terragrunt.stack.hcl", "hcl:terragrunt-stack:native"),
            ("terragrunt.values.hcl", "hcl:terragrunt-values:native"),
            ("docker-bake.hcl", "hcl:generic:native"),
        ] {
            assert_eq!(
                detect_language(&RepoPath::from_protocol(path).unwrap()),
                Some((Language::Hcl, mode.into())),
                "{path}"
            );
        }
    }

    #[test]
    fn shell_shebang_refines_dialect_and_mode_includes_host_os() {
        for (path, source, dialect) in [
            ("script.sh", b"#!/usr/bin/env bash\n".as_slice(), "bash"),
            ("script.bash", b"#!/bin/sh\n".as_slice(), "sh"),
            (
                "script.sh",
                b"#!/usr/bin/env -S bash -eu\n".as_slice(),
                "bash",
            ),
            (
                "script.bash",
                b"#!/usr/bin/env -u bash sh\n".as_slice(),
                "sh",
            ),
            ("script.sh", b"#!/usr/bin/dash\n".as_slice(), "sh"),
            ("script.sh", b"echo portable\n".as_slice(), "sh"),
        ] {
            assert_eq!(
                resolve_language(&RepoPath::from_protocol(path).unwrap(), source),
                Some((
                    Language::Shell,
                    format!("shell:{dialect}:{}", std::env::consts::OS)
                )),
                "{path}"
            );
        }
    }
}

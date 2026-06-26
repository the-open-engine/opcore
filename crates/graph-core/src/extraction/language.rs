use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SourceLanguage {
    TypeScript,
    TypeScriptJsx,
    JavaScript,
    JavaScriptJsx,
}

impl SourceLanguage {
    pub fn from_path(path: &Path) -> Option<Self> {
        match path.extension().and_then(|extension| extension.to_str()) {
            Some("ts") => Some(Self::TypeScript),
            Some("tsx") => Some(Self::TypeScriptJsx),
            Some("js") => Some(Self::JavaScript),
            Some("jsx") => Some(Self::JavaScriptJsx),
            _ => None,
        }
    }

    pub fn unsupported_source_extension(path: &Path) -> Option<String> {
        let extension = path.extension()?.to_str()?;
        match extension {
            "py" | "rs" | "mjs" | "cjs" | "mts" | "cts" | "vue" | "svelte" | "go" | "java"
            | "rb" | "php" | "swift" | "kt" | "cs" | "cpp" | "c" | "h" | "hpp" => {
                Some(extension.to_string())
            }
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript",
            Self::TypeScriptJsx => "tsx",
            Self::JavaScript => "javascript",
            Self::JavaScriptJsx => "jsx",
        }
    }
}

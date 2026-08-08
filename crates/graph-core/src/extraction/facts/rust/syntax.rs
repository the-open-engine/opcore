use super::*;

pub(super) struct ModuleScope {
    pub(super) parent: String,
    pub(super) name: String,
    pub(super) is_test: bool,
}

pub(super) struct Syntax;

pub(super) trait RustSyntax {
    fn is_exported(visibility: &Visibility) -> bool;
    fn has_test_attr(attributes: &[Attribute]) -> bool;
    fn has_cfg_test(attributes: &[Attribute]) -> bool;
    fn signature_for_module(item: &ItemMod) -> String;
    fn signature_for_function(item: &ItemFn) -> String;
    fn signature_for_method(item: &syn::ImplItemFn) -> String;
    fn signature_for_item(item: &impl ToTokens) -> String;
    fn visibility_tokens(visibility: &Visibility) -> String;
    fn type_name(ty: &Type) -> Option<String>;
    fn path_last_segment(path: &SynPath) -> Option<String>;
    fn impl_name(trait_name: Option<&str>, self_type: &str) -> String;
    fn reference_name_for_path(path: &SynPath) -> Option<String>;
    fn base_attributes(
        exported: bool,
        qualified_name: &str,
        signature: Option<String>,
        span: Option<proc_macro2::Span>,
    ) -> Value;
    fn attributes_object(value: &mut Value) -> &mut serde_json::Map<String, Value>;
    fn path_to_string(path: impl AsRef<Path>) -> String;
}

impl RustSyntax for Syntax {
    fn is_exported(visibility: &Visibility) -> bool {
        !matches!(visibility, Visibility::Inherited)
    }

    fn has_test_attr(attributes: &[Attribute]) -> bool {
        attributes
            .iter()
            .any(|attribute| attribute.path().is_ident("test"))
    }

    fn has_cfg_test(attributes: &[Attribute]) -> bool {
        attributes.iter().any(|attribute| {
            attribute.path().is_ident("cfg")
                && attribute
                    .meta
                    .to_token_stream()
                    .to_string()
                    .contains("test")
        })
    }

    fn signature_for_module(item: &ItemMod) -> String {
        format!("{}mod {}", Self::visibility_tokens(&item.vis), item.ident)
            .trim()
            .to_string()
    }

    fn signature_for_function(item: &ItemFn) -> String {
        format!(
            "{}{}",
            Self::visibility_tokens(&item.vis),
            item.sig.to_token_stream()
        )
        .trim()
        .to_string()
    }

    fn signature_for_method(item: &syn::ImplItemFn) -> String {
        format!(
            "{}{}",
            Self::visibility_tokens(&item.vis),
            item.sig.to_token_stream()
        )
        .trim()
        .to_string()
    }

    fn signature_for_item(item: &impl ToTokens) -> String {
        item.to_token_stream().to_string()
    }

    fn visibility_tokens(visibility: &Visibility) -> String {
        let tokens = visibility.to_token_stream().to_string();
        if tokens.is_empty() {
            tokens
        } else {
            format!("{tokens} ")
        }
    }

    fn type_name(ty: &Type) -> Option<String> {
        match ty {
            Type::Path(path) => Self::path_last_segment(&path.path),
            _ => None,
        }
    }

    fn path_last_segment(path: &SynPath) -> Option<String> {
        path.segments
            .last()
            .map(|segment| segment.ident.to_string())
    }

    fn impl_name(trait_name: Option<&str>, self_type: &str) -> String {
        match trait_name {
            Some(trait_name) => format!("impl {trait_name} for {self_type}"),
            None => format!("impl {self_type}"),
        }
    }

    fn reference_name_for_path(path: &SynPath) -> Option<String> {
        let parts = path
            .segments
            .iter()
            .map(|segment| segment.ident.to_string())
            .collect::<Vec<_>>();
        if parts.is_empty() {
            return None;
        }
        if parts
            .iter()
            .any(|part| part == "self" || part == "Self" || part == "super" || part == "crate")
        {
            return None;
        }
        let separator = if parts.len() > 1 { "." } else { "" };
        if separator.is_empty() {
            parts.first().cloned()
        } else {
            Some(parts.join(separator))
        }
    }

    fn base_attributes(
        exported: bool,
        qualified_name: &str,
        signature: Option<String>,
        span: Option<proc_macro2::Span>,
    ) -> Value {
        let mut attributes = serde_json::Map::new();
        attributes.insert("language".to_string(), Value::String("rust".to_string()));
        attributes.insert("exported".to_string(), Value::Bool(exported));
        attributes.insert(
            "qualifiedName".to_string(),
            Value::String(qualified_name.to_string()),
        );
        if exported {
            attributes.insert("exportKind".to_string(), Value::String("named".to_string()));
            attributes.insert(
                "exportName".to_string(),
                Value::String(qualified_name.to_string()),
            );
        }
        if let Some(signature) = signature {
            attributes.insert("signature".to_string(), Value::String(signature));
        }
        if let Some(span) = span {
            let start = span.start();
            let end = span.end();
            attributes.insert("lineStart".to_string(), json!(start.line));
            attributes.insert("lineEnd".to_string(), json!(end.line));
            attributes.insert("columnStart".to_string(), json!(start.column));
            attributes.insert("columnEnd".to_string(), json!(end.column));
        }
        Value::Object(attributes)
    }

    fn attributes_object(value: &mut Value) -> &mut serde_json::Map<String, Value> {
        loop {
            if let Value::Object(object) = value {
                return object;
            }
            *value = Value::Object(serde_json::Map::new());
        }
    }

    fn path_to_string(path: impl AsRef<Path>) -> String {
        path.as_ref().to_string_lossy().replace('\\', "/")
    }
}

use super::*;

pub(super) struct Helpers;

pub(super) trait CollectorHelpers {
    fn import_bindings(
        specifiers: Option<&oxc_allocator::Vec<'_, ImportDeclarationSpecifier<'_>>>,
    ) -> Vec<ImportBinding>;
    fn module_export_name(name: &ModuleExportName<'_>) -> String;
    fn binding_name(pattern: &BindingPattern<'_>) -> Option<String>;
    fn is_function_like(expression: &Expression<'_>) -> bool;
    fn first_string_argument(arguments: &oxc_allocator::Vec<'_, Argument<'_>>) -> Option<String>;
    fn expression_name(expression: &Expression<'_>) -> Option<String>;
    fn unwrapped_expression<'a>(expression: &'a Expression<'a>) -> &'a Expression<'a>;
    fn static_member_name(member: &oxc_ast::ast::StaticMemberExpression<'_>) -> Option<String>;
    fn ts_type_name(name: &TSTypeName<'_>) -> Option<String>;
    fn function_name(function: &Function<'_>) -> Option<String>;
    fn class_name(class: &Class<'_>) -> Option<String>;
    fn default_export_local(expression: &Expression<'_>) -> Option<String>;
    fn ensure_export_attribute(node: &mut GraphFactNode);
    fn apply_export_attributes(node: &mut GraphFactNode, export: &ExportContext, local_name: &str);
    fn registers_default_export_alias(export: &ExportContext, local_name: &str) -> bool;
}

impl CollectorHelpers for Helpers {
    fn import_bindings(
        specifiers: Option<&oxc_allocator::Vec<'_, ImportDeclarationSpecifier<'_>>>,
    ) -> Vec<ImportBinding> {
        specifiers
            .into_iter()
            .flat_map(|items| items.iter())
            .map(|specifier| match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(specifier) => ImportBinding {
                    local: specifier.local.name.to_string(),
                    imported: Self::module_export_name(&specifier.imported),
                },
                ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => ImportBinding {
                    local: specifier.local.name.to_string(),
                    imported: "default".to_string(),
                },
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => ImportBinding {
                    local: specifier.local.name.to_string(),
                    imported: "*".to_string(),
                },
            })
            .collect()
    }

    fn module_export_name(name: &ModuleExportName<'_>) -> String {
        match name {
            ModuleExportName::IdentifierName(name) => name.name.to_string(),
            ModuleExportName::IdentifierReference(name) => name.name.to_string(),
            ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
        }
    }

    fn binding_name(pattern: &BindingPattern<'_>) -> Option<String> {
        match pattern {
            BindingPattern::BindingIdentifier(identifier) => Some(identifier.name.to_string()),
            _ => None,
        }
    }

    fn is_function_like(expression: &Expression<'_>) -> bool {
        matches!(
            expression,
            Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)
        )
    }

    fn first_string_argument(arguments: &oxc_allocator::Vec<'_, Argument<'_>>) -> Option<String> {
        arguments.first().and_then(|argument| match argument {
            Argument::StringLiteral(literal) => Some(literal.value.to_string()),
            _ => None,
        })
    }

    fn expression_name(expression: &Expression<'_>) -> Option<String> {
        let expression = Self::unwrapped_expression(expression);
        match expression {
            Expression::Identifier(identifier) => Some(identifier.name.to_string()),
            Expression::StaticMemberExpression(member) => Self::static_member_name(member),
            _ => None,
        }
    }

    fn unwrapped_expression<'a>(expression: &'a Expression<'a>) -> &'a Expression<'a> {
        let mut current = expression;
        loop {
            current = match current {
                Expression::ParenthesizedExpression(expression) => &expression.expression,
                Expression::TSAsExpression(expression) => &expression.expression,
                Expression::TSSatisfiesExpression(expression) => &expression.expression,
                Expression::TSNonNullExpression(expression) => &expression.expression,
                Expression::TSInstantiationExpression(expression) => &expression.expression,
                _ => return current,
            };
        }
    }

    fn static_member_name(member: &oxc_ast::ast::StaticMemberExpression<'_>) -> Option<String> {
        let property = member.property.name.to_string();
        match &member.object {
            Expression::Identifier(object) => Some(format!("{}.{}", object.name, property)),
            _ => Some(property),
        }
    }

    fn ts_type_name(name: &TSTypeName<'_>) -> Option<String> {
        match name {
            TSTypeName::IdentifierReference(identifier) => Some(identifier.name.to_string()),
            TSTypeName::QualifiedName(_) | TSTypeName::ThisExpression(_) => None,
        }
    }

    fn function_name(function: &Function<'_>) -> Option<String> {
        function.id.as_ref().map(|id| id.name.to_string())
    }

    fn class_name(class: &Class<'_>) -> Option<String> {
        class.id.as_ref().map(|id| id.name.to_string())
    }

    fn default_export_local(expression: &Expression<'_>) -> Option<String> {
        match Self::unwrapped_expression(expression) {
            Expression::Identifier(identifier) => Some(identifier.name.to_string()),
            _ => None,
        }
    }

    fn ensure_export_attribute(node: &mut GraphFactNode) {
        let attributes = node_attributes_object(node);
        attributes
            .entry("exported".to_string())
            .or_insert_with(|| Value::Bool(false));
    }

    fn apply_export_attributes(node: &mut GraphFactNode, export: &ExportContext, local_name: &str) {
        let attributes = node_attributes_object(node);
        attributes.insert("exported".to_string(), Value::Bool(true));
        attributes.insert(
            "exportKind".to_string(),
            Value::String(export.export_kind.clone()),
        );
        attributes.insert(
            "exportName".to_string(),
            Value::String(export.export_name_for(local_name)),
        );
    }

    fn registers_default_export_alias(export: &ExportContext, local_name: &str) -> bool {
        export.export_kind == "default" || export.export_name_for(local_name) == "default"
    }
}

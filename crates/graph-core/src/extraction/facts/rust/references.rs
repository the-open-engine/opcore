use super::*;

pub(super) struct References;

pub(super) trait RustReferences {
    fn collect(from: String, block: &syn::Block, is_test: bool) -> Vec<ReferenceFact>;
}

impl RustReferences for References {
    fn collect(from: String, block: &syn::Block, is_test: bool) -> Vec<ReferenceFact> {
        let mut visitor = RustReferenceVisitor {
            from,
            is_test,
            references: Vec::new(),
        };
        visitor.visit_block(block);
        visitor.references
    }
}

struct RustReferenceVisitor {
    from: String,
    is_test: bool,
    references: Vec<ReferenceFact>,
}

impl RustReferenceVisitor {
    fn push_path_reference(&mut self, path: &SynPath) {
        if let Some(name) = Syntax::reference_name_for_path(path) {
            self.references.push(ReferenceFact {
                from: self.from.clone(),
                name,
                is_test: self.is_test,
            });
        }
    }
}

impl<'ast> Visit<'ast> for RustReferenceVisitor {
    fn visit_expr_call(&mut self, node: &'ast ExprCall) {
        if let syn::Expr::Path(path) = node.func.as_ref() {
            self.push_path_reference(&path.path);
        }
        visit::visit_expr_call(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        self.references.push(ReferenceFact {
            from: self.from.clone(),
            name: node.method.to_string(),
            is_test: self.is_test,
        });
        visit::visit_expr_method_call(self, node);
    }

    fn visit_expr_macro(&mut self, node: &'ast ExprMacro) {
        self.push_path_reference(&node.mac.path);
        visit::visit_expr_macro(self, node);
    }
}

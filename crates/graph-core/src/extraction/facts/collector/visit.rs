use super::*;

pub(super) trait CollectProgram<'a> {
    fn collect_program(&mut self, program: &oxc_ast::ast::Program<'a>);
}

impl<'a> CollectProgram<'a> for FileFactCollector {
    fn collect_program(&mut self, program: &oxc_ast::ast::Program<'a>) {
        self.visit_program(program);
    }
}

impl<'a> Visit<'a> for FileFactCollector {
    fn visit_import_declaration(&mut self, import: &ImportDeclaration<'a>) {
        self.imports.push(ImportFact {
            specifier: import.source.value.to_string(),
            bindings: Helpers::import_bindings(import.specifiers.as_ref()),
        });
    }

    fn visit_import_expression(&mut self, import: &ImportExpression<'a>) {
        if let Expression::StringLiteral(source) = &import.source {
            self.imports.push(ImportFact {
                specifier: source.value.to_string(),
                bindings: Vec::new(),
            });
        }
        walk::walk_import_expression(self, import);
    }

    fn visit_ts_import_type(&mut self, import: &TSImportType<'a>) {
        self.imports.push(ImportFact {
            specifier: import.source.value.to_string(),
            bindings: Vec::new(),
        });
        walk::walk_ts_import_type(self, import);
    }

    fn visit_export_named_declaration(&mut self, export: &ExportNamedDeclaration<'a>) {
        let source = export
            .source
            .as_ref()
            .map(|source| source.value.to_string());
        if let Some(source) = &source {
            self.imports.push(ImportFact {
                specifier: source.clone(),
                bindings: export
                    .specifiers
                    .iter()
                    .map(|specifier| ImportBinding {
                        local: Helpers::module_export_name(&specifier.exported),
                        imported: Helpers::module_export_name(&specifier.local),
                    })
                    .collect(),
            });
        }
        if let Some(declaration) = &export.declaration {
            self.with_export(ExportContext::named(None), |collector| {
                collector.visit_declaration(declaration)
            });
        }
        for specifier in &export.specifiers {
            let local = Helpers::module_export_name(&specifier.local);
            let exported = Helpers::module_export_name(&specifier.exported);
            if let Some(source) = &source {
                self.re_exports.push(ReExportFact {
                    specifier: source.clone(),
                    imported: local.clone(),
                    exported: exported.clone(),
                });
                self.record_file_export(json!({
                    "kind": "named",
                    "local": local,
                    "exported": exported,
                    "source": source,
                    "imported": Helpers::module_export_name(&specifier.local),
                    "supportedSymbol": false
                }));
            } else {
                if !self.top_level_declarations.contains_key(&local) {
                    if let Some(imported) = self.import_backed_local(&local) {
                        self.record_file_export(json!({
                            "kind": "named",
                            "local": local,
                            "exported": exported,
                            "source": imported.source,
                            "imported": imported.imported,
                            "supportedSymbol": false
                        }));
                        continue;
                    }
                }
                self.mark_exported(&local, ExportContext::named(Some(exported.clone())));
                self.record_file_export(json!({
                    "kind": "named",
                    "local": local,
                    "exported": exported,
                    "source": null,
                    "supportedSymbol": true
                }));
            }
        }
    }

    fn visit_export_all_declaration(&mut self, export: &ExportAllDeclaration<'a>) {
        self.imports.push(ImportFact {
            specifier: export.source.value.to_string(),
            bindings: Vec::new(),
        });
        let source = export.source.value.to_string();
        if let Some(exported) = &export.exported {
            self.record_file_export(json!({
                    "kind": "namespace",
                    "exported": Helpers::module_export_name(exported),
                "source": source,
                "supportedSymbol": false
            }));
        } else {
            self.record_file_export(json!({
                "kind": "all",
                "exported": "*",
                "source": source,
                "supportedSymbol": false
            }));
        }
    }

    fn visit_export_default_declaration(&mut self, export: &ExportDefaultDeclaration<'a>) {
        match &export.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                self.record_file_export(json!({
                    "kind": "default",
                    "local": Helpers::function_name(function).unwrap_or_else(|| "default".to_string()),
                    "exported": "default",
                    "source": null,
                    "supportedSymbol": true
                }));
                self.with_export(ExportContext::default(), |collector| {
                    collector.visit_function(function, ScopeFlags::Function)
                });
            }
            ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                self.record_file_export(json!({
                    "kind": "default",
                    "local": Helpers::class_name(class).unwrap_or_else(|| "default".to_string()),
                    "exported": "default",
                    "source": null,
                    "supportedSymbol": true
                }));
                self.with_export(ExportContext::default(), |collector| {
                    collector.visit_class(class)
                });
            }
            ExportDefaultDeclarationKind::TSInterfaceDeclaration(declaration) => {
                self.record_file_export(json!({
                    "kind": "default",
                    "local": declaration.id.name.as_ref(),
                    "exported": "default",
                    "source": null,
                    "supportedSymbol": true
                }));
                self.with_export(ExportContext::default(), |collector| {
                    collector.visit_ts_interface_declaration(declaration)
                });
            }
            _ => {
                let expression = export.declaration.to_expression();
                let local = Helpers::default_export_local(expression);
                if let Some(local) = &local {
                    if !self.top_level_declarations.contains_key(local) {
                        if let Some(imported) = self.import_backed_local(local) {
                            self.record_file_export(json!({
                                "kind": "default",
                                "local": local,
                                "exported": "default",
                                "source": imported.source,
                                "imported": imported.imported,
                                "supportedSymbol": false
                            }));
                            self.visit_expression(expression);
                            return;
                        }
                    }
                    self.mark_exported(local, ExportContext::default());
                }
                self.record_file_export(json!({
                    "kind": "default",
                    "local": local,
                    "exported": "default",
                    "source": null,
                    "supportedSymbol": local.is_some()
                }));
                self.visit_expression(expression);
            }
        }
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        if let Some(name) = Helpers::function_name(function) {
            let id = self.add_declaration("function", "Function", &name);
            self.with_context(id, |collector| {
                walk::walk_function(collector, function, flags)
            });
        } else if self
            .current_export
            .as_ref()
            .is_some_and(|export| export.export_kind == "default")
        {
            let id = self.add_default_declaration("function", "Function");
            self.with_context(id, |collector| {
                walk::walk_function(collector, function, flags)
            });
        } else {
            walk::walk_function(self, function, flags);
        }
    }

    fn visit_class(&mut self, class: &Class<'a>) {
        if let Some(name) = Helpers::class_name(class) {
            let id = self.add_declaration("class", "Class", &name);
            if let Some(super_class) = class
                .super_class
                .as_ref()
                .and_then(Helpers::expression_name)
            {
                self.heritage.push(HeritageFact {
                    from: id.clone(),
                    name: super_class,
                    kind: "INHERITS".to_string(),
                });
            }
            for implemented in &class.implements {
                if let Some(name) = Helpers::ts_type_name(&implemented.expression) {
                    self.heritage.push(HeritageFact {
                        from: id.clone(),
                        name,
                        kind: "IMPLEMENTS".to_string(),
                    });
                }
            }
            self.with_context(id, |collector| walk::walk_class(collector, class));
        } else if self
            .current_export
            .as_ref()
            .is_some_and(|export| export.export_kind == "default")
        {
            let id = self.add_default_declaration("class", "Class");
            self.with_context(id, |collector| walk::walk_class(collector, class));
        } else {
            walk::walk_class(self, class);
        }
    }

    fn visit_ts_type_alias_declaration(&mut self, declaration: &TSTypeAliasDeclaration<'a>) {
        self.add_declaration("type", "Type", declaration.id.name.as_ref());
        walk::walk_ts_type_alias_declaration(self, declaration);
    }

    fn visit_ts_interface_declaration(&mut self, declaration: &TSInterfaceDeclaration<'a>) {
        let id = self.add_declaration("type", "Type", declaration.id.name.as_ref());
        for extended in &declaration.extends {
            if let Some(name) = Helpers::expression_name(&extended.expression) {
                self.heritage.push(HeritageFact {
                    from: id.clone(),
                    name,
                    kind: "INHERITS".to_string(),
                });
            }
        }
        walk::walk_ts_interface_declaration(self, declaration);
    }

    fn visit_variable_declaration(&mut self, declaration: &VariableDeclaration<'a>) {
        for declarator in &declaration.declarations {
            if let Some(type_annotation) = &declarator.type_annotation {
                self.visit_ts_type_annotation(type_annotation);
            }
            if let Some(name) = Helpers::binding_name(&declarator.id) {
                if self.current_context.is_none() {
                    let Some(init) = declarator.init.as_ref() else {
                        self.add_declaration("variable", "Variable", &name);
                        continue;
                    };
                    if Helpers::is_function_like(init) {
                        let id = self.add_declaration("function", "Function", &name);
                        self.with_context(id, |collector| collector.visit_expression(init));
                    } else {
                        let id = self.add_declaration("variable", "Variable", &name);
                        self.with_context(id, |collector| collector.visit_expression(init));
                    }
                    continue;
                }
            }
            if let Some(init) = declarator.init.as_ref() {
                self.visit_expression(init);
            }
        }
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if let Some(callee) = Helpers::expression_name(&call.callee) {
            if callee == "test" || callee == "it" {
                let Some(test_name) = Helpers::first_string_argument(&call.arguments) else {
                    walk::walk_call_expression(self, call);
                    return;
                };
                let test_id = self.add_test(&test_name);
                self.with_context(test_id, |collector| {
                    walk::walk_call_expression(collector, call)
                });
                return;
            }
            if callee != "describe" && callee != "test" && callee != "it" {
                self.add_reference(callee);
            }
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_new_expression(&mut self, expression: &NewExpression<'a>) {
        if let Some(callee) = Helpers::expression_name(&expression.callee) {
            self.add_reference(callee);
        }
        walk::walk_new_expression(self, expression);
    }
}

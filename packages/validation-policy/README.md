# Opcore Validation Policy

Shared repo validation policy parsing and check composition for Opcore-owned validation entrypoints.

Python import-dependent checks require `pythonImportAnalyzer` composition. Opcore and ASP inject the graph package adapter; validation-policy forwards the structural interface without importing graph implementation internals.

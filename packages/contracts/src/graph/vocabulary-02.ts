const graphExtractionDiagnosticCategories = [
  "missing_tsconfig",
  "malformed_tsconfig",
  "unsupported_language",
  "parse_error",
  "missing_parser",
  "unresolved_import",
  "max_files_exceeded",
  "max_depth_exceeded",
  "path_traversal",
  "io_error",
] as const;

export { graphExtractionDiagnosticCategories };

type GraphExtractionDiagnosticCategory = (typeof graphExtractionDiagnosticCategories)[number];

export type { GraphExtractionDiagnosticCategory };

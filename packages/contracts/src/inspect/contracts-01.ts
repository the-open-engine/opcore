import type { GraphNodeKind } from "../graph/vocabulary-01.js";

interface InspectSymbolTarget {
  kind: "node" | "file_symbol";
  nodeId?: string;
  path?: string;
  symbolName?: string;
  line?: number;
  column?: number;
}

export type { InspectSymbolTarget };

type InspectReferenceTarget = InspectSymbolTarget;

export type { InspectReferenceTarget };

interface InspectTextSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startOffset?: number;
  endOffset?: number;
}

export type { InspectTextSpan };

type InspectReferenceSpan = InspectTextSpan;

export type { InspectReferenceSpan };

interface InspectSymbolSummary {
  id: string;
  name: string;
  kind?: GraphNodeKind;
}

export type { InspectSymbolSummary };

interface InspectSymbolEvidence {
  graphNodeIds: readonly string[];
  resolver: "graph" | "language_service";
}

export type { InspectSymbolEvidence };

interface InspectReferenceEntry {
  file: string;
  line: number;
  column: number;
  text: string;
  span: InspectTextSpan;
  symbol: InspectSymbolSummary;
  isDefinition: boolean;
  isDeclaration?: boolean;
  evidence: InspectSymbolEvidence;
}

export type { InspectReferenceEntry };

const inspectSignatureKinds = [
  "function",
  "method",
  "constructor",
  "interface",
  "type_alias",
  "class",
  "variable_function",
] as const;

export { inspectSignatureKinds };

type InspectSignatureKind = (typeof inspectSignatureKinds)[number];

export type { InspectSignatureKind };

interface InspectSignatureParameter {
  name: string;
  type: string;
  optional: boolean;
  rest?: boolean;
  defaultValue?: string;
}

export type { InspectSignatureParameter };

interface InspectSignatureTypeParameter {
  name: string;
  constraint?: string;
  default?: string;
}

export type { InspectSignatureTypeParameter };

interface InspectSignatureEntry {
  file: string;
  line: number;
  column: number;
  text: string;
  signature: string;
  kind: InspectSignatureKind;
  parameters: readonly InspectSignatureParameter[];
  typeParameters: readonly InspectSignatureTypeParameter[];
  exported: boolean;
  async: boolean;
  returnType?: string;
  span: InspectTextSpan;
  symbol: InspectSymbolSummary;
  overloadIndex?: number;
  evidence: InspectSymbolEvidence;
}

export type { InspectSignatureEntry };

const inspectImplementationKinds = ["implements", "inherited_implements", "extends", "interface_extends"] as const;

export { inspectImplementationKinds };

type InspectImplementationKind = (typeof inspectImplementationKinds)[number];

export type { InspectImplementationKind };

interface InspectImplementationEntry {
  file: string;
  line: number;
  column: number;
  text: string;
  span: InspectTextSpan;
  kind: InspectImplementationKind;
  symbol: InspectSymbolSummary;
  target: InspectSymbolSummary;
  isDeclaration?: boolean;
  evidence: InspectSymbolEvidence;
}

export type { InspectImplementationEntry };

const inspectFailureCategories = [
  "graph_unavailable",
  "target_ambiguous",
  "target_not_found",
  "unsupported_language",
  "malformed_target",
  "language_service_error",
  "unsupported_route",
] as const;

export { inspectFailureCategories };

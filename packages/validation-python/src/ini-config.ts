export interface PythonIniDocument {
  sections: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

interface MutableIniState {
  sections: Map<string, Map<string, string>>;
  section?: string;
  option?: string;
}

export function parsePythonIni(content: string): PythonIniDocument {
  const state: MutableIniState = { sections: new Map() };
  for (const [index, rawLine] of content.replace(/^\uFEFF/u, "").split(/\r?\n/u).entries()) {
    parseIniLine(state, rawLine, index + 1);
  }
  if (state.sections.size === 0) throw new Error("INI config has no sections");
  return { sections: state.sections };
}

export function pythonIniHasSection(document: PythonIniDocument | undefined, section: string): boolean {
  return document?.sections.has(section.toLowerCase()) ?? false;
}

export function pythonIniValue(
  document: PythonIniDocument | undefined,
  section: string,
  option: string
): string | undefined {
  return document?.sections.get(section.toLowerCase())?.get(option.toLowerCase());
}

function parseIniLine(state: MutableIniState, rawLine: string, lineNumber: number): void {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith(";")) return;
  if (/^\s/u.test(rawLine)) {
    appendContinuation(state, trimmed, lineNumber);
    return;
  }
  const section = /^\[([^\[\]]+)\](?:\s*[#;].*)?$/u.exec(trimmed)?.[1]?.trim().toLowerCase();
  if (section !== undefined) {
    if (section.length === 0 || state.sections.has(section)) throw new Error(`Invalid INI section at line ${lineNumber}`);
    state.sections.set(section, new Map());
    state.section = section;
    delete state.option;
    return;
  }
  parseIniOption(state, rawLine, lineNumber);
}

function parseIniOption(state: MutableIniState, rawLine: string, lineNumber: number): void {
  if (state.section === undefined) throw new Error(`INI option precedes a section at line ${lineNumber}`);
  const delimiter = firstIniDelimiter(rawLine);
  const option = delimiter < 1 ? "" : rawLine.slice(0, delimiter).trim().toLowerCase();
  if (option.length === 0) throw new Error(`Invalid INI option at line ${lineNumber}`);
  const section = state.sections.get(state.section);
  if (section === undefined || section.has(option)) throw new Error(`Duplicate INI option at line ${lineNumber}`);
  section.set(option, rawLine.slice(delimiter + 1).trim());
  state.option = option;
}

function appendContinuation(state: MutableIniState, value: string, lineNumber: number): void {
  if (state.section === undefined || state.option === undefined) {
    throw new Error(`Unexpected INI continuation at line ${lineNumber}`);
  }
  const section = state.sections.get(state.section);
  const previous = section?.get(state.option);
  if (section === undefined || previous === undefined) throw new Error(`Invalid INI continuation at line ${lineNumber}`);
  section.set(state.option, previous.length === 0 ? value : `${previous}\n${value}`);
}

function firstIniDelimiter(line: string): number {
  const equals = line.indexOf("=");
  const colon = line.indexOf(":");
  if (equals < 0) return colon;
  if (colon < 0) return equals;
  return Math.min(equals, colon);
}

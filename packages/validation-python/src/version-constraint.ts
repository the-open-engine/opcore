interface ParsedPythonPrerelease {
  kind: "a" | "b" | "rc";
  number: number;
}

interface ParsedPythonVersion {
  release: readonly [number, number, number];
  precision: number;
  prerelease?: ParsedPythonPrerelease;
}

interface ParsedPythonConstraintClause extends ParsedPythonVersion {
  operator: "===" | "==" | "!=" | ">=" | "<=" | ">" | "<" | "~=";
  wildcard: boolean;
}

export function isSupportedPythonVersionConstraint(constraint: string): boolean {
  const clauses = constraint.split(",").map((part) => part.trim()).filter(Boolean);
  return clauses.length > 0 && clauses.every((clause) => parseConstraintClause(clause) !== undefined);
}

export function pythonVersionSatisfiesConstraint(version: string, constraint: string): boolean {
  const current = parsePythonVersion(version);
  if (current === undefined) return false;
  const clauses = constraint.split(",").map((part) => part.trim()).filter(Boolean);
  if (clauses.length === 0) return false;
  const targets = clauses.map(parseConstraintClause);
  if (targets.some((target) => target === undefined)) return false;
  const parsedTargets = targets as ParsedPythonConstraintClause[];
  if (current.prerelease !== undefined && !parsedTargets.some((target) => target.prerelease !== undefined)) return false;
  return parsedTargets.every((target) => {
    const comparison = compareVersion(current, target);
    switch (target.operator) {
      case ">=": return comparison >= 0;
      case ">": return comparison > 0;
      case "<=": return comparison <= 0;
      case "<": return comparison < 0;
      case "!=": return !equalVersion(current, target);
      case "~=": {
        const compatiblePrefixLength = target.precision - 1;
        return comparison >= 0 && releasePrefixMatches(current.release, target.release, compatiblePrefixLength);
      }
      case "===": return comparison === 0;
      case "==": return equalVersion(current, target);
    }
  });
}

function parseConstraintClause(value: string): ParsedPythonConstraintClause | undefined {
  const match = /^(?<operator>===|==|!=|>=|<=|>|<|~=)?\s*(?<version>\d+(?:\.\d+){1,2}(?:(?:a|b|rc)\d+)?)(?<wildcard>\.\*)?$/u.exec(value);
  if (match?.groups === undefined) return undefined;
  const parsed = parsePythonVersion(match.groups.version);
  if (parsed === undefined) return undefined;
  const operator = (match.groups.operator ?? "==") as ParsedPythonConstraintClause["operator"];
  const wildcard = match.groups.wildcard !== undefined;
  if (wildcard && operator !== "==" && operator !== "!=") return undefined;
  return { ...parsed, operator, wildcard };
}

function parsePythonVersion(value: string): ParsedPythonVersion | undefined {
  const match = /^(?<major>\d+)\.(?<minor>\d+)(?:\.(?<patch>\d+))?(?:(?<prereleaseKind>a|b|rc)(?<prereleaseNumber>\d+))?(?:\+[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)?$/u.exec(value.trim());
  if (match?.groups === undefined) return undefined;
  const prereleaseKind = match.groups.prereleaseKind as ParsedPythonPrerelease["kind"] | undefined;
  return {
    release: [Number(match.groups.major), Number(match.groups.minor), Number(match.groups.patch ?? 0)],
    precision: match.groups.patch === undefined ? 2 : 3,
    ...(prereleaseKind === undefined
      ? {}
      : { prerelease: { kind: prereleaseKind, number: Number(match.groups.prereleaseNumber) } })
  };
}

function equalVersion(current: ParsedPythonVersion, target: ParsedPythonConstraintClause): boolean {
  if (target.wildcard) return releasePrefixMatches(current.release, target.release, target.precision);
  return compareVersion(current, target) === 0;
}

function releasePrefixMatches(left: readonly number[], right: readonly number[], length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function compareVersion(left: ParsedPythonVersion, right: ParsedPythonVersion): number {
  const releaseComparison = compareRelease(left.release, right.release);
  if (releaseComparison !== 0) return releaseComparison;
  if (left.prerelease === undefined || right.prerelease === undefined) {
    if (left.prerelease === undefined && right.prerelease === undefined) return 0;
    return left.prerelease === undefined ? 1 : -1;
  }
  const rank = { a: 0, b: 1, rc: 2 } as const;
  const kindComparison = rank[left.prerelease.kind] - rank[right.prerelease.kind];
  return kindComparison !== 0 ? kindComparison : left.prerelease.number - right.prerelease.number;
}

function compareRelease(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return (left[index] ?? 0) - (right[index] ?? 0);
  }
  return 0;
}

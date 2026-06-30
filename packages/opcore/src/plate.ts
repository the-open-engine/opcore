import type { OpcoreRepoStatePayload, ValidationResult } from "@the-open-engine/opcore-contracts";

/**
 * Human, TTY-only "constraint plate" rendering for `opcore` scan and
 * `opcore check`. This is presentation only: the stable text contract
 * (formatScanMessage) and the JSON payloads are unchanged, and the plate is
 * built as plain text first, then colorized by token replacement so ANSI
 * escapes never shift the box-drawing alignment.
 */

const RUST = "38;2;194;36;12";
const W = 74;

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function topBorder(left: string, right: string): string {
  const start = `┌─ ${left} `;
  const end = ` ${right} ─┐`;
  const fill = Math.max(1, W - start.length - end.length);
  return start + "─".repeat(fill) + end;
}

function bottomBorder(): string {
  return "└" + "─".repeat(W - 2) + "┘";
}

function midLine(left: string, right: string): string {
  const inner = W - 4;
  const gap = Math.max(1, inner - left.length - right.length);
  const content = (left + " ".repeat(gap) + right).slice(0, inner);
  return `│ ${padEnd(content, inner)} │`;
}

function sectionRule(label: string): string {
  const head = `${label} `;
  return head + "─".repeat(Math.max(3, W - head.length));
}

function footRule(): string {
  return "─".repeat(W);
}

function gauge(value: number, total: number, width = 17): string {
  if (total <= 0) return "·".repeat(width);
  const on = Math.max(0, Math.min(width, Math.round((value / total) * width)));
  return "█".repeat(on) + "░".repeat(width - on);
}

function pct(value: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

const TIER: Record<string, string> = {
  typescript: "deep",
  javascript: "deep",
  tsx: "deep",
  jsx: "deep",
  rust: "useful",
  python: "experimental"
};

function statusWord(status: string): string {
  if (status === "passed") return "PASS";
  if (status === "failed") return "FAIL";
  return status.toUpperCase();
}

function colorize(plain: string): string {
  const rust = (s: string): string => `\x1b[${RUST}m${s}\x1b[0m`;
  const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
  const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
  return plain
    .replace(/BLOCKED {2}✗/g, bold(rust("BLOCKED  ✗")))
    .replace(/validation FAILED/g, bold("validation ") + rust("FAILED"))
    .replace(/out of tolerance/g, bold("out of tolerance"))
    .replace(/within tolerance/g, bold("within tolerance"))
    .replace(/\bFAIL\b/g, rust("FAIL"))
    .replace(/№ 001/g, rust("№ 001"))
    .replace(/◦/g, rust("◦"))
    .replace(/\bexit 1\b/g, rust("exit 1"))
    .replace(/counted, never faked/g, dim("counted, never faked"))
    .replace(/degraded-honest/g, dim("degraded-honest"))
    .replace(/^( {2}next .*)$/gm, dim("$1"))
    .replace(/agent-safe JSON on stdout/g, dim("agent-safe JSON on stdout"));
}

export function formatScanPlate(
  repoState: OpcoreRepoStatePayload,
  validationResult: ValidationResult,
  options: { color: boolean }
): string {
  const coverage = repoState.coverage;
  const total = coverage.totalFiles;
  const graphState = repoState.graph.state === "available" ? "graph fresh" : `graph ${repoState.graph.state}`;
  const runs = validationResult.manifest?.runs ?? [];
  const failed = runs.filter((run) => run.status !== "passed");

  const lines: string[] = [];
  lines.push("  " + topBorder("OPCORE", "LAYER 02 · CONSTRAINTS"));
  lines.push("  " + midLine("◦ live    deterministic · local · read-only", "№ 001 · scan"));
  lines.push("  " + bottomBorder());
  lines.push(`  ./${basename(repoState.repo.root)}   ·   ${total} files   ·   ${graphState}`);
  lines.push("");

  // COVERAGE — before findings
  lines.push("  " + sectionRule("COVERAGE ── what this pass can actually hold"));
  const languages = [...coverage.languages].sort((a, b) => b.files - a.files);
  for (const entry of languages) {
    const tier = TIER[entry.language.toLowerCase()] ?? "";
    const note = tier === "experimental" ? "   degraded-honest" : "";
    lines.push(
      "    " +
        padEnd(tier, 8) +
        padEnd(entry.language, 16) +
        padStart(`${entry.files} files`, 11) +
        "  " +
        gauge(entry.files, total) +
        "  " +
        padStart(pct(entry.files, total), 4) +
        note
    );
  }
  const unsupported = coverage.unsupported.stacks;
  if (unsupported.length > 0) {
    const census = unsupported.map((stack) => `${stack.language} ${stack.count}`).join(" · ");
    lines.push("    " + padEnd("none", 8) + padEnd(census, 27) + "counted, never faked");
  }
  lines.push("    " + "─".repeat(W - 4));
  const degraded =
    repoState.validation.degradedToolchains.length === 0
      ? "none"
      : repoState.validation.degradedToolchains.map((tool) => `${tool.adapter}:${tool.tool}`).join(", ");
  lines.push(
    `    graph-supported ${coverage.graph.supportedFiles}   ·   validation-supported ${coverage.validation.supportedFiles} (+${coverage.validation.retainedFiles} retained)   ·   degraded tools: ${degraded}`
  );
  lines.push("");

  // FINDINGS — after coverage
  lines.push("  " + sectionRule("FINDINGS ── facts, not a score"));
  const diagnostics = validationResult.diagnostics;
  lines.push(`    ${diagnostics.length} diagnostics`);
  const shown = diagnostics.slice(0, 6);
  shown.forEach((diagnostic, index) => {
    const branch = index === shown.length - 1 && diagnostics.length <= 6 ? "└" : "├";
    const tail = diagnostic.code ? diagnostic.code : diagnostic.message;
    lines.push(
      `      ${branch} ${padEnd(diagnostic.category, 18)} ${padEnd(diagnostic.path ?? "", 32)} ${truncate(tail, 22)}`
    );
  });
  if (diagnostics.length > shown.length) {
    lines.push(`      (+${diagnostics.length - shown.length} more)`);
  }
  lines.push("");

  // GATE — per-check verdicts
  if (runs.length > 0) {
    const cells = runs.map((run) => `${run.checkId} ${statusWord(run.status)}`);
    lines.push("  GATE   " + wrapCells(cells, "         "));
  }

  lines.push("  " + footRule());
  const verdict = validationResult.status === "passed" ? "validation PASSED" : "validation FAILED";
  lines.push(`  ${verdict} · ${failed.length} checks · activation ${repoState.activation.level}`);
  lines.push("  next  opcore check --changed --json       exit  0 pass · 1 findings · 64 unsupported");

  const plate = lines.join("\n");
  return options.color ? colorize(plate) : plate;
}

export function formatCheckStamp(
  args: { validationResult: ValidationResult; scope: string; base?: string; color: boolean }
): string {
  const { validationResult, scope, base } = args;
  const runs = validationResult.manifest?.runs ?? [];
  const failed = runs.filter((run) => run.status !== "passed");
  const passed = validationResult.status === "passed";
  const verdictRight = passed ? "CLEARED  ◦" : "BLOCKED  ✗";

  const lines: string[] = [];
  lines.push("  " + topBorder(`OPCORE · ${scope}`, base ? `vs ${base} · № 001` : "№ 001"));
  lines.push("  " + midLine(`${runs.length} checks`, verdictRight));
  lines.push("  " + bottomBorder());

  if (passed) {
    const cells = runs.map((run) => `${run.checkId} PASS`);
    lines.push("    " + wrapCells(cells, "    "));
    lines.push("  " + footRule());
    lines.push("  within tolerance · 0 findings · exit 0");
  } else {
    const rows = failed.slice(0, 6);
    for (const run of rows) {
      lines.push(`    ${padEnd(statusWord(run.status), 6)} ${run.checkId}`);
    }
    const passingCells = runs.filter((run) => run.status === "passed").map((run) => `${run.checkId} PASS`);
    if (passingCells.length > 0) lines.push("    " + wrapCells(passingCells, "    "));
    lines.push("  " + footRule());
    lines.push(
      `  out of tolerance · ${validationResult.diagnostics.length} findings · exit 1 · agent-safe JSON on stdout`
    );
  }

  const plate = lines.join("\n");
  return args.color ? colorize(plate) : plate;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function wrapCells(cells: readonly string[], indent: string): string {
  const out: string[] = [];
  let line = "";
  for (const cell of cells) {
    const next = line.length === 0 ? cell : `${line} · ${cell}`;
    if (next.length > W - 8 && line.length > 0) {
      out.push(line);
      line = cell;
    } else {
      line = next;
    }
  }
  if (line.length > 0) out.push(line);
  return out.join("\n" + indent);
}

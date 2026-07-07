import type { OpcoreInitScanSummary } from "@the-open-engine/opcore-contracts";
import {
  CANCEL_KEYS,
  createWizardTheme,
  displayWidth,
  DOWN_KEYS,
  ENTER_KEYS,
  fit,
  gutter,
  LEFT_KEYS,
  padEndPlain,
  padStartPlain,
  RIGHT_KEYS,
  seconds,
  stepHead,
  UP_KEYS,
  WIZARD_SPINNER,
  WIZARD_WIDTH,
  WizardScreen,
  type WizardTheme
} from "./install-wizard-screen.js";

/**
 * Interactive TTY presentation for `opcore install` (issue #199).
 *
 * This module is presentation and keyboard interaction only: it renders the
 * "flight check" wizard (rail glyphs, live scan, coverage, scope radio,
 * toggleable plan, Install/Cancel row) through an injected IO seam and never
 * touches the filesystem, plan semantics, JSON payloads, or non-TTY output.
 * Decoration goes to stderr; the stable text contract stays on stdout.
 */

export interface InstallWizardIO {
  write(text: string): void;
  readKey(): Promise<string>;
  color: boolean;
  /** false disables animation sleeps so tests and slow terminals stay instant. */
  motion: boolean;
}

export type InstallWizardGroupKey = "skill" | "hooks" | "precommit";

export interface InstallWizardChoices {
  agentSkill: boolean;
  writeGateHooks: boolean;
  activePreCommitHook: boolean;
}

export interface InstallWizardFileRow {
  path: string;
  mark: "+" | "~" | "»";
  outsideOpcore: boolean;
}

export interface InstallWizardPlanView {
  baseRows: readonly InstallWizardFileRow[];
  groupRows: Readonly<Record<InstallWizardGroupKey, readonly InstallWizardFileRow[]>>;
  totalWrites: number;
  outsideWrites: number;
}

export interface InstallWizardGroup {
  key: InstallWizardGroupKey;
  label: string;
  available: boolean;
  unavailableNote?: string;
}

export interface InstallWizardPlanModel {
  groups: readonly InstallWizardGroup[];
  initial: InstallWizardChoices;
  planView(choices: InstallWizardChoices): InstallWizardPlanView;
}

export interface InstallWizardPlanOutcome {
  choices: InstallWizardChoices;
  confirmed: boolean;
}

const GAUGE_CELLS = 10;

const LANGUAGE_TIERS: Record<string, string> = {
  typescript: "deep",
  tsx: "deep",
  javascript: "deep",
  jsx: "deep",
  rust: "useful",
  python: "exp."
};

export function createInstallWizardRenderer(io: InstallWizardIO, trueColor: boolean): InstallWizardRenderer {
  return new InstallWizardRenderer(io, createWizardTheme(io.color, trueColor));
}

export class InstallWizardRenderer {
  readonly screen: WizardScreen;

  constructor(private readonly io: InstallWizardIO, private readonly theme: WizardTheme) {
    this.screen = new WizardScreen(io);
  }

  hideCursor(): void {
    this.io.write("\x1b[?25l");
  }

  showCursor(): void {
    this.io.write("\x1b[?25h");
  }

  header(repoLabel: string): void {
    const theme = this.theme;
    const left = "opcore install";
    const right = fit(repoLabel, WIZARD_WIDTH - left.length - 4);
    const gap = Math.max(2, WIZARD_WIDTH + 2 - left.length - displayWidth(right));
    this.screen.line(`  ${theme.bold(theme.accent(left))}${" ".repeat(gap)}${theme.dim(right)}`);
    this.screen.line(`  ${theme.dim("Every change, within tolerance. · read-only until you approve")}`);
    this.screen.line();
  }

  scanFrame(frame: number, elapsedMs: number): void {
    const theme = this.theme;
    this.screen.paint([
      stepHead(theme, "active", "Scan", theme.dim("read-only")),
      gutter(theme, `${theme.accent(WIZARD_SPINNER[frame % WIZARD_SPINNER.length])}  scanning repository  ${theme.accent(seconds(elapsedMs))}`)
    ]);
  }

  scanDone(scanMs: number, totalFiles: number | undefined): void {
    const theme = this.theme;
    const meta = totalFiles === undefined ? seconds(scanMs) : `${seconds(scanMs)} · ${totalFiles} files`;
    this.screen.commit([stepHead(theme, "done", "Scan", theme.dim(meta))]);
    this.screen.line(gutter(theme));
  }

  scanFailed(scanMs: number): void {
    const theme = this.theme;
    this.screen.commit([stepHead(theme, "done", "Scan", theme.accent(`failed after ${seconds(scanMs)}`))]);
  }

  private coverageLines(scan: OpcoreInitScanSummary): string[] {
    const theme = this.theme;
    const total = Math.max(1, scan.totalFiles);
    const languages = [...scan.languages].sort((a, b) => b.files - a.files);
    const shown = languages.slice(0, 4);
    const rest = languages.slice(4);
    const lines: string[] = [];
    for (const entry of shown) {
      const tier = LANGUAGE_TIERS[entry.language.toLowerCase()] ?? "";
      const cells = Math.max(entry.files > 0 ? 1 : 0, Math.round((entry.files / total) * GAUGE_CELLS));
      const bar = theme.accent("█".repeat(Math.min(GAUGE_CELLS, cells))) + theme.dim("░".repeat(Math.max(0, GAUGE_CELLS - cells)));
      const pct = `${Math.round((entry.files / total) * 100)}%`;
      lines.push(
        gutter(
          theme,
          `${theme.dim(padEndPlain(tier, 7))}${padEndPlain(fit(entry.language, 12), 13)}${padStartPlain(String(entry.files), 5)}  ${bar}  ${theme.dim(padStartPlain(pct, 4))}`
        )
      );
    }
    if (rest.length > 0) {
      const files = rest.reduce((sum, entry) => sum + entry.files, 0);
      lines.push(gutter(theme, `${theme.dim(padEndPlain("", 7))}${padEndPlain("other supported", 13)}${padStartPlain(String(files), 5)}`));
    }
    if (scan.unsupportedFiles > 0) {
      lines.push(
        gutter(
          theme,
          `${theme.dim(padEndPlain("—", 7))}${padEndPlain("unsupported", 13)}${padStartPlain(String(scan.unsupportedFiles), 5)}  ${theme.dim("not analyzed")}`
        )
      );
    }
    lines.push(gutter(theme, `checks cover ${scan.validationSupportedFiles} of ${scan.totalFiles} files`));
    lines.push(gutter(theme, this.findingsSummary(scan, true)));
    const rustPresent = scan.languages.some((entry) => entry.language.toLowerCase() === "rust");
    if (rustPresent && scan.degradedRustTools.length > 0) {
      const count = scan.degradedRustTools.length;
      lines.push(gutter(theme, theme.dim(`${count} rust ${count === 1 ? "tool" : "tools"} missing — related checks skipped`)));
    }
    return lines;
  }

  private findingsSummary(scan: OpcoreInitScanSummary, styled: boolean): string {
    const theme = this.theme;
    const findings = `${scan.diagnosticCount} ${scan.diagnosticCount === 1 ? "finding" : "findings"}`;
    if (scan.failedChecks.length === 0) return `${findings} · all checks passed`;
    const names = scan.failedChecks.slice(0, 2).map((checkId) => (styled ? theme.accent(checkId) : checkId));
    const more = scan.failedChecks.length > 2 ? ` +${scan.failedChecks.length - 2}` : "";
    return `${findings} · ${scan.failedChecks.length} ${scan.failedChecks.length === 1 ? "check" : "checks"} failed  ${names.join(" · ")}${more}`;
  }

  async coverage(scan: OpcoreInitScanSummary): Promise<void> {
    const theme = this.theme;
    const body = this.coverageLines(scan);
    const activeHead = stepHead(theme, "active", "Coverage", theme.dim(`${scan.totalFiles} files`));
    for (let index = 1; index <= body.length; index += 1) {
      this.screen.paint([activeHead, ...body.slice(0, index)]);
      await this.screen.sleep(45);
    }
    await this.screen.sleep(120);
    const failed = scan.failedChecks.length;
    const findings = `${scan.diagnosticCount} ${scan.diagnosticCount === 1 ? "finding" : "findings"}`;
    const meta = failed === 0
      ? `${scan.totalFiles} files · ${findings}`
      : `${scan.totalFiles} files · ${findings} · ${failed} ${failed === 1 ? "check" : "checks"} failed`;
    this.screen.commit([stepHead(theme, "done", "Coverage", theme.dim(meta)), ...body]);
    this.screen.line(gutter(theme));
  }

  private scopeLines(repoLabel: string, index: number, confirmed: "repo" | "global" | null): string[] {
    const theme = this.theme;
    if (confirmed !== null) {
      return [stepHead(theme, "done", "Scope", theme.dim(confirmed === "repo" ? "this repo" : "all repos"))];
    }
    const options = [
      { label: "this repo", note: fit(repoLabel, 44) },
      { label: "all repos", note: "~/.opcore · ~/.claude · ~/.codex" }
    ];
    const lines = [stepHead(theme, "active", "Scope", theme.dim("write-gate reach")), gutter(theme)];
    options.forEach((option, optionIndex) => {
      const lit = optionIndex === index;
      const cursor = lit ? theme.accent("▸") : " ";
      const radio = lit ? theme.accent("◉") : theme.dim("○");
      const label = lit ? theme.bold(padEndPlain(option.label, 11)) : padEndPlain(option.label, 11);
      lines.push(gutter(theme, `${cursor} ${radio}  ${label}${theme.dim(option.note)}`));
    });
    lines.push(gutter(theme));
    lines.push(gutter(theme, theme.dim("↑↓ move · ↵ confirm · esc cancel")));
    return lines;
  }

  async selectScope(repoLabel: string): Promise<"repo" | "global" | null> {
    let index = 0;
    this.screen.paint(this.scopeLines(repoLabel, index, null));
    for (;;) {
      const key = await this.io.readKey();
      if (CANCEL_KEYS.has(key)) return null;
      index = scopeIndexForKey(key, index);
      if (ENTER_KEYS.has(key) || key === "r" || key === "g") {
        const scope = index === 0 ? "repo" : "global";
        this.screen.commit(this.scopeLines(repoLabel, index, scope));
        this.screen.line(gutter(this.theme));
        return scope;
      }
      this.screen.paint(this.scopeLines(repoLabel, index, null));
    }
  }

  private planLines(frame: PlanFrame): string[] {
    const theme = this.theme;
    const lines = [
      stepHead(theme, "active", "Plan", theme.dim(`${frame.view.totalWrites} writes · nothing written yet`)),
      gutter(theme)
    ];
    if (frame.view.baseRows.length > 0) {
      const base = frame.view.baseRows.map((row) => (row.outsideOpcore ? row.path : theme.dim(row.path)));
      lines.push(gutter(theme, `${theme.dim(padEndPlain("base", 5))} ${fitJoined(base, theme.dim(" · "), WIZARD_WIDTH - 12)}`));
      lines.push(gutter(theme));
    }
    lines.push(...this.planGroupLines(frame));
    lines.push(gutter(theme));
    lines.push(...this.planActionLines(frame));
    return lines;
  }

  private planGroupLines(frame: PlanFrame): string[] {
    const theme = this.theme;
    const lines: string[] = [];
    let focusIndex = 0;
    for (const group of frame.groups) {
      if (!group.available) {
        lines.push(gutter(theme, theme.dim(`  [-] ${group.label}  ${group.unavailableNote ?? "unavailable"}`)));
        continue;
      }
      const enabled = choiceFor(frame.choices, group.key);
      const focused = frame.focus === focusIndex;
      const cursor = focused ? theme.accent("▸") : " ";
      const box = enabled ? "[x]" : theme.dim("[ ]");
      const label = focused ? theme.bold(group.label) : enabled ? group.label : theme.dim(group.label);
      lines.push(gutter(theme, `${cursor} ${box} ${label}`));
      if (enabled) lines.push(...this.planFileLines(frame.view.groupRows[group.key] ?? []));
      focusIndex += 1;
    }
    return lines;
  }

  private planFileLines(rows: readonly InstallWizardFileRow[]): string[] {
    const theme = this.theme;
    return rows.map((row) => {
      const path = row.outsideOpcore ? row.path : theme.dim(row.path);
      return gutter(theme, `     ${theme.dim(row.mark)} ${path}`);
    });
  }

  private planActionLines(frame: PlanFrame): string[] {
    const theme = this.theme;
    const onAction = frame.focus === frame.focusableCount;
    const install = onAction && frame.action === 0 ? theme.accent(theme.bold("▸ Install")) : theme.dim("  Install");
    const cancel = onAction && frame.action === 1 ? theme.bold("▸ Cancel") : theme.dim("  Cancel");
    const hint = onAction ? "←→ choose · ↵ confirm · esc cancel" : "↑↓ move · space toggle · ↵ continue";
    return [gutter(theme, `${install}     ${cancel}`), gutter(theme, theme.dim(hint))];
  }

  async planApproval(model: InstallWizardPlanModel): Promise<InstallWizardPlanOutcome> {
    const focusable = model.groups.filter((group) => group.available);
    const frame: PlanFrame = {
      groups: model.groups,
      focusableCount: focusable.length,
      choices: { ...model.initial },
      view: model.planView(model.initial),
      focus: 0,
      action: 0
    };
    this.screen.paint(this.planLines(frame));
    for (;;) {
      const key = await this.io.readKey();
      if (CANCEL_KEYS.has(key)) return { choices: frame.choices, confirmed: false };
      const outcome = this.reducePlanKey(model, focusable, frame, key);
      if (outcome !== null) return outcome;
      this.screen.paint(this.planLines(frame));
    }
  }

  private reducePlanKey(
    model: InstallWizardPlanModel,
    focusable: readonly InstallWizardGroup[],
    frame: PlanFrame,
    key: string
  ): InstallWizardPlanOutcome | null {
    if (UP_KEYS.has(key)) frame.focus = Math.max(0, frame.focus - 1);
    else if (DOWN_KEYS.has(key)) frame.focus = Math.min(focusable.length, frame.focus + 1);
    else if (frame.focus === focusable.length && (LEFT_KEYS.has(key) || RIGHT_KEYS.has(key))) {
      frame.action = frame.action === 0 ? 1 : 0;
    } else if (key === " " && frame.focus < focusable.length) {
      toggleChoice(frame.choices, focusable[frame.focus].key);
      frame.view = model.planView(frame.choices);
    } else if (ENTER_KEYS.has(key)) {
      return this.reducePlanEnter(frame);
    }
    return null;
  }

  private reducePlanEnter(frame: PlanFrame): InstallWizardPlanOutcome | null {
    const theme = this.theme;
    if (frame.focus < frame.focusableCount) {
      frame.focus = frame.focusableCount;
      return null;
    }
    if (frame.action === 1) return { choices: frame.choices, confirmed: false };
    if (frame.view.totalWrites === 0) return null;
    this.screen.commit([
      stepHead(theme, "done", "Plan", theme.dim(`${frame.view.totalWrites} writes · ${frame.view.outsideWrites} touch your files`)),
      gutter(theme, theme.dim("guardrails, not enforcement · existing lint/test/CI untouched"))
    ]);
    this.screen.line(gutter(theme));
    return { choices: frame.choices, confirmed: true };
  }

  async applyCascade(paths: readonly string[], applyMs: number): Promise<void> {
    const theme = this.theme;
    const frame = (shown: number): string[] => [
      stepHead(theme, "active", "Install", theme.dim(`writing ${paths.length}`)),
      ...paths.map((path, index) => {
        const sealed = index < shown;
        const rail = sealed ? theme.accent("┃") : theme.dim("│");
        const glyph = sealed ? theme.accent("✓") : theme.dim("◇");
        return `  ${rail}   ${glyph}  ${sealed ? path : theme.dim(path)}`;
      })
    ];
    for (let shown = 0; shown <= paths.length; shown += 1) {
      this.screen.paint(frame(shown));
      await this.screen.sleep(45);
    }
    await this.screen.sleep(100);
    this.screen.commit([stepHead(theme, "done", "Install", theme.dim(`${paths.length} files · ${seconds(applyMs)}`))]);
    this.screen.line(gutter(theme));
  }

  doneCard(totalWrites: number, scope: "repo" | "global", undoCommand: string): void {
    const theme = this.theme;
    const boxWidth = 70;
    const top = (() => {
      const left = `┌─ ${theme.accent("OPCORE")} · INSTALLED `;
      const right = " within tolerance ─┐";
      const fill = Math.max(1, boxWidth - displayWidth(left) - displayWidth(right));
      return `  ${left}${theme.accent("─".repeat(fill))}${right}`;
    })();
    const row = (text: string): string => {
      const inner = `  ${text}`;
      const pad = Math.max(0, boxWidth - 2 - displayWidth(inner));
      return `  │${inner}${" ".repeat(pad)}│`;
    };
    this.screen.line(top);
    this.screen.line(row(`${totalWrites} files written · ${scope === "repo" ? "repo" : "global"} scope`));
    this.screen.line(row(`${theme.dim("undo   ")}${undoCommand}`));
    this.screen.line(row(`${theme.dim("next   ")}${theme.accent("opcore check --changed")}${theme.dim("  ·  ")}${theme.accent("opcore measure")}`));
    this.screen.line(`  └${theme.accent("─".repeat(boxWidth - 2))}┘`);
    this.screen.line();
  }

  cancelled(): void {
    const theme = this.theme;
    this.screen.commit([
      stepHead(theme, "done", "Cancelled", theme.dim("nothing written")),
      gutter(theme, `${theme.dim("scan was read-only · re-run ")}${theme.accent("opcore install")}${theme.dim(" when ready")}`)
    ]);
    this.screen.line();
  }
}

interface PlanFrame {
  groups: readonly InstallWizardGroup[];
  focusableCount: number;
  choices: InstallWizardChoices;
  view: InstallWizardPlanView;
  focus: number;
  action: 0 | 1;
}

function scopeIndexForKey(key: string, index: number): number {
  if (UP_KEYS.has(key) || key === "r") return 0;
  if (DOWN_KEYS.has(key) || key === "g") return 1;
  return index;
}

function choiceFor(choices: InstallWizardChoices, key: InstallWizardGroupKey): boolean {
  if (key === "skill") return choices.agentSkill;
  if (key === "hooks") return choices.writeGateHooks;
  return choices.activePreCommitHook;
}

function toggleChoice(choices: InstallWizardChoices, key: InstallWizardGroupKey): void {
  if (key === "skill") choices.agentSkill = !choices.agentSkill;
  else if (key === "hooks") choices.writeGateHooks = !choices.writeGateHooks;
  else choices.activePreCommitHook = !choices.activePreCommitHook;
}

function fitJoined(parts: readonly string[], separator: string, max: number): string {
  let joined = "";
  for (let index = 0; index < parts.length; index += 1) {
    const next = joined.length === 0 ? parts[index] : `${joined}${separator}${parts[index]}`;
    if (displayWidth(next) > max && joined.length > 0) {
      return `${joined}${separator}+${parts.length - index}`;
    }
    joined = next;
  }
  return joined;
}

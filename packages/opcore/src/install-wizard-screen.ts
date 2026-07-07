/**
 * Low-level terminal primitives for the `opcore install` wizard: ANSI theme,
 * display-width helpers, the repaint-in-place live region, rail glyph lines,
 * and the shared keyboard key sets. Presentation only — no filesystem access.
 */

export const WIZARD_WIDTH = 74;
export const WIZARD_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const ACCENT_TRUECOLOR = "38;2;194;36;12";
const ACCENT_256 = "38;5;130";

export type WizardStyle = (text: string) => string;

export interface WizardTheme {
  accent: WizardStyle;
  bold: WizardStyle;
  dim: WizardStyle;
  plain: WizardStyle;
}

export function createWizardTheme(color: boolean, trueColor: boolean): WizardTheme {
  if (!color) {
    const plain: WizardStyle = (text) => text;
    return { accent: plain, bold: plain, dim: plain, plain };
  }
  const sgr = (code: string): WizardStyle => (text) => `\x1b[${code}m${text}\x1b[0m`;
  return {
    accent: sgr(trueColor ? ACCENT_TRUECOLOR : ACCENT_256),
    bold: sgr("1"),
    dim: sgr("2"),
    plain: (text) => text
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function displayWidth(text: string): number {
  return [...stripAnsi(text)].length;
}

export function fit(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…` : text;
}

export function padEndPlain(text: string, width: number): string {
  const length = [...text].length;
  return length >= width ? text : text + " ".repeat(width - length);
}

export function padStartPlain(text: string, width: number): string {
  const length = [...text].length;
  return length >= width ? text : " ".repeat(width - length) + text;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Live region renderer: repaints only the in-progress block in place with
 * cursor-up + clear, so committed steps scroll away as a clean transcript.
 */
export class WizardScreen {
  private live = 0;

  constructor(private readonly io: { write(text: string): void; motion: boolean }) {}

  paint(lines: readonly string[]): void {
    let out = "";
    if (this.live > 0) out += `\x1b[${this.live}A\x1b[0J`;
    out += `${lines.join("\n")}\n`;
    this.io.write(out);
    this.live = lines.length;
  }

  commit(lines: readonly string[]): void {
    this.paint(lines);
    this.live = 0;
  }

  line(text = ""): void {
    this.commit([text]);
  }

  async sleep(ms: number): Promise<void> {
    if (!this.io.motion || ms <= 0) return;
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, ms);
    });
  }
}

export function stepHead(theme: WizardTheme, state: "active" | "done", title: string, meta: string): string {
  const glyph = state === "active" ? "◆" : "●";
  const glyphStyle = state === "active" ? theme.accent : theme.plain;
  const titleStyle = state === "active" ? theme.bold : theme.plain;
  const dots = Math.max(2, WIZARD_WIDTH - `${glyph}  ${title}`.length - displayWidth(meta) - 2);
  return `  ${glyphStyle(glyph)}  ${titleStyle(title)} ${theme.dim("·".repeat(dots))}${meta ? ` ${meta}` : ""}`;
}

export function gutter(theme: WizardTheme, text = ""): string {
  return `  ${theme.dim("│")}${text ? `    ${text}` : ""}`;
}

export const CANCEL_KEYS = new Set(["\x1b", "q", "\x03"]);
export const UP_KEYS = new Set(["\x1b[A", "k"]);
export const DOWN_KEYS = new Set(["\x1b[B", "j"]);
export const LEFT_KEYS = new Set(["\x1b[D", "h"]);
export const RIGHT_KEYS = new Set(["\x1b[C", "l"]);
export const ENTER_KEYS = new Set(["\r", "\n"]);

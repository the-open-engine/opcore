import type { OpcoreSetupCommand } from "./init-types.js";

export function opcoreSetupHelpMessage(command: OpcoreSetupCommand): string {
  if (command === "install") return opcoreInstallHelpMessage();
  if (command === "uninstall") return opcoreUninstallHelpMessage();
  return opcoreInitHelpMessage();
}

function opcoreInitHelpMessage(): string {
  return [
    "Usage:",
    "  opcore init [--repo <path>] [--local|--global] [--approve] [--json]",
    "  opcore init --undo --approve [--repo <path>] [--local|--global] [--json]",
    "Flags:",
    "  --repo <path>          Repository root to set up.",
    "  --local                Force repo-scoped setup.",
    "  --global               Install the write gate in user-level agent settings.",
    "  --approve              Apply the proposed additive setup.",
    "  --undo                 Revert files recorded in .opcore/init-undo.json.",
    "  --fail-closed-hook     Add the optional fail-closed pre-commit hook.",
    "  --json                 Emit structured JSON.",
    "Defaults:",
    "  Without --approve, init is plan-only outside an interactive approval prompt.",
    "  Inside a Git repo on a TTY, init asks whether to install for this repo or globally.",
    "Examples:",
    "  opcore init --repo . --json",
    "  opcore init --repo . --approve",
    "  opcore init --global --approve",
    "Exit codes: 0 planned or applied, 1 setup error, 64 unsupported."
  ].join("\n");
}

function opcoreInstallHelpMessage(): string {
  return [
    "Usage:", "  opcore install [--repo <path>] [--local|--global] [--yes] [--json]",
    "Flags:", "  --repo <path>          Repository root to set up.",
    "  --local                Force repo-scoped setup.",
    "  --global               Install user-level agent skills and write-gate hooks.",
    "  --yes                 Apply the proposed setup without prompting.",
    "  --no-skill             Do not install the Opcore agent skill.",
    "  --no-pre-commit        Do not install the repo Git pre-commit hook.",
    "  --json                 Emit structured JSON.",
    "Defaults:",
    "  install scans first, then applies on --yes or an interactive default-yes approval prompt.",
    "Examples:", "  opcore install", "  opcore install --repo . --yes",
    "Exit codes: 0 planned or applied, 1 setup error, 64 unsupported."
  ].join("\n");
}

function opcoreUninstallHelpMessage(): string {
  return [
    "Usage:", "  opcore uninstall [--repo <path>] [--local|--global] [--yes] [--json]",
    "Flags:", "  --repo <path>          Repository root to restore/remove recorded setup from.",
    "  --local                Force repo-scoped uninstall.",
    "  --global               Restore/remove user-level recorded setup.",
    "  --yes                 Apply the uninstall without prompting.",
    "  --json                 Emit structured JSON.",
    "Defaults:", "  uninstall restores or removes only files recorded in .opcore/init-undo.json.",
    "Examples:", "  opcore uninstall --repo . --yes", "  opcore uninstall --global --yes",
    "Exit codes: 0 planned or applied, 1 setup error, 64 unsupported."
  ].join("\n");
}

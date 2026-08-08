export const HELP_ARGS = new Set(["--help", "-h", "help"]);
export const AGENT_FILE_CANDIDATES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  ".codex/AGENTS.md",
  ".opencode/AGENTS.md"
] as const;

export const BEGIN_MARKER = "<!-- BEGIN OPCORE INIT -->";
export const END_MARKER = "<!-- END OPCORE INIT -->";
export const CONFIG_PATH = ".opcore/config";
export const UNDO_PATH = ".opcore/init-undo.json";
export const HOOK_PATH = ".opcore/hooks/pre-commit-opcore-check.sh";
export const AGENT_GATE_HOOK_PATH = ".opcore/hooks/opcore-agent-gate.mjs";
export const REPO_AGENT_SKILL_PATH = ".agents/skills/opcore/SKILL.md";
export const CLAUDE_AGENT_SKILL_PATH = ".claude/skills/opcore/SKILL.md";
export const AGENT_SKILL_PATHS = [REPO_AGENT_SKILL_PATH, CLAUDE_AGENT_SKILL_PATH] as const;
export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
export const CODEX_HOOKS_PATH = ".codex/hooks.json";
export const ACTIVE_PRE_COMMIT_HOOK_PATH = ".git/hooks/pre-commit";
export const FAIL_CLOSED_HOOK_ACTIVATION_COMMAND =
  "cp .opcore/hooks/pre-commit-opcore-check.sh .git/hooks/pre-commit";
export const GITIGNORE_PATH = ".gitignore";
export const OPCORE_IGNORE_LINE = ".opcore/";
export const DEFAULT_INIT_PROGRESS_INTERVAL_MS = 5000;
export const GLOBAL_UNDO_PATH = ".opcore/init-undo.json";

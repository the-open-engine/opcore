import type { CommandGroupContract } from "./contracts.js";
import { commandRouterManifest } from "./manifest.js";

function commandGroupByName(groupName: string): CommandGroupContract | undefined {
  return commandRouterManifest.commandGroups.find((group) => group.name === groupName);
}

export { commandGroupByName };

function commandHelpMessage(groupName?: string, routeName?: string): string {
  if (!groupName) {
    return [
      "Opcore - local code intelligence and edit safety for coding agents.",
      "Groups: graph, inspect, edit, check, validate, status, doctor",
    ].join("\n");
  }
  const group = commandGroupByName(groupName);
  if (!group) return `Unknown opcore command group: ${groupName}`;
  const routeHelp = routeName ? commandRouteHelpMessage(groupName, routeName) : undefined;
  if (routeHelp !== undefined) return routeHelp;
  return [
    `${group.canonicalCommand.join(" ")} - ${group.summary}`,
    `Commands: ${group.commands.join(", ")}`,
    ...(groupName === "graph" ? [`Syntax: ${contractHelpSyntax(group)}`] : []),
    `Example: ${contractHelpExample(groupName)}`,
  ].join("\n");
}

export { commandHelpMessage };

function commandRouteHelpMessage(groupName: string, routeName: string): string | undefined {
  if (groupName === "graph" && routeName === "update") {
    return [
      "Usage: opcore graph update [--repo <path>] [--base <ref>] [--paths <path...>] [--json]",
      "Flags:",
      "  --repo <path>       Repository root to update.",
      "  --base <ref>        Optional base ref for changed-file metadata.",
      "  --paths <path...>   Optional repo-relative paths to refresh.",
      "  --json              Emit structured JSON.",
      "Defaults:",
      "  --repo defaults to the current working directory; JSON output is summary-oriented.",
      "Examples:",
      "  opcore graph update --repo . --base HEAD --json",
      "  opcore graph update --repo . --paths src tests --json",
      "Exit codes: 0 updated, 1 update failed, 64 unsupported.",
    ].join("\n");
  }
  if (groupName === "graph" && routeName === "build") {
    return [
      "Usage: opcore graph build [--repo <path>] [--paths <path...>] [--json]",
      "Flags:",
      "  --repo <path>       Repository root to build.",
      "  --paths <path...>   Optional repo-relative paths to index.",
      "  --json              Emit structured JSON.",
      "Defaults:",
      "  --repo defaults to the current working directory; JSON output is summary-oriented.",
      "Examples:",
      "  opcore graph build --repo . --json",
      "Exit codes: 0 built, 1 build failed, 64 unsupported.",
    ].join("\n");
  }
  if (groupName === "graph" && routeName === "status") {
    return [
      "Usage: opcore graph status [--repo <path>] [--json]",
      "Flags:",
      "  --repo <path>       Repository root to inspect.",
      "  --json              Emit structured JSON.",
      "Defaults:",
      "  --repo defaults to the current working directory.",
      "Examples:",
      "  opcore graph status --repo . --json",
      "Exit codes: 0 available or stale status read, 1 status failed, 64 unsupported.",
    ].join("\n");
  }
  if (groupName === "validate" && routeName === "pre-write") {
    return [
      "Usage: opcore validate pre-write --request-file <file> [--timeout-ms <ms>] [--json]",
      "Flags:",
      "  --request-file <file>  ValidationRequest JSON payload.",
      "  --timeout-ms <ms>      Pre-write timeout in milliseconds.",
      "  --json                 Emit structured JSON.",
      "Defaults:",
      "  --timeout-ms defaults to 30000.",
      "Examples:",
      "  opcore validate pre-write --request-file ./validation-request.json --timeout-ms 30000 --json",
      "Exit codes: 0 passed, 1 findings or errors, 64 unsupported.",
    ].join("\n");
  }
  return undefined;
}

export { commandRouteHelpMessage };

function contractHelpSyntax(group: CommandGroupContract): string {
  return `${group.canonicalCommand.join(" ")} <${group.commands.join("|")}> --repo . [--json]`;
}

export { contractHelpSyntax };

function contractHelpExample(groupName: string): string {
  if (groupName === "graph") return 'opcore graph search "GreetingCard" --repo . --limit 5';
  if (groupName === "inspect") return "opcore inspect definition GreetingCard --repo .";
  if (groupName === "edit") return 'opcore edit exact --path src/a.ts --expected "old" --replacement "new" --json';
  if (groupName === "check") return "opcore check files --files src/index.ts --json";
  if (groupName === "validate")
    return "opcore validate pre-write --request-file ./validation-request.json --timeout-ms 30000 --json";
  if (groupName === "status") return "opcore status";
  if (groupName === "doctor") return "opcore doctor --json";
  return `opcore ${groupName} --help`;
}

export { contractHelpExample };

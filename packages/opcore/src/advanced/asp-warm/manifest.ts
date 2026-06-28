export const aspWarmSessionManifest = {
  publicHelp: false,
  stateDir: ".lattice/asp",
  capabilities: ["check", "inspect/references", "edit/rename", "session/shutdown"],
  writesSourceFiles: false,
  autoSpawned: false,
  alwaysOn: false
} as const;

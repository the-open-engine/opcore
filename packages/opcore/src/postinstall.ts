declare const process: {
  stdout: {
    write(text: string): void;
  };
};

const cyan = "\x1b[36m";
const green = "\x1b[32m";
const bold = "\x1b[1m";
const reset = "\x1b[0m";

try {
  process.stdout.write([
    "",
    `${cyan}${bold}   ___  ____   ___ ___  ____  _____${reset}`,
    `${cyan}${bold}  / _ \\|  _ \\ / __/ _ \\|  _ \\| ____|${reset}`,
    `${cyan}${bold} | | | | |_) | | | | | | |_) |  _|${reset}`,
    `${cyan}${bold} | |_| |  __/| |__| |_| |  _ <| |___${reset}`,
    `${cyan}${bold}  \\___/|_|    \\___\\___/|_| \\_\\_____|${reset}`,
    "",
    `${green}${bold}OPCORE${reset}`,
    `${green}Opcore installed.${reset}`,
    `Run ${bold}opcore init${reset} inside a repo to install the repo write gate.`,
    `Run ${bold}opcore init --global${reset} to install the global write gate.`,
    "Setup is approval-gated; install does not modify your repos or agent settings.",
    ""
  ].join("\n"));
} catch {
  // Postinstall messaging is best-effort and must never affect installation.
}

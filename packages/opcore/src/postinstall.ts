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
    `Run ${bold}opcore install${reset} inside a repo to install the repo write gate.`,
    `Run ${bold}opcore install --global${reset} to install the global write gate.`,
    "The npm postinstall only prints this message; run the command above to approve setup.",
    ""
  ].join("\n"));
} catch {
  // Postinstall messaging is best-effort and must never affect installation.
}

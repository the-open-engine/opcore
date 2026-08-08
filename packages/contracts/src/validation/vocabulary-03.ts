const latencyTelemetrySourceFileExtensionRegex = new RegExp(
  String.raw`\.(?:[cm]?[tj]sx?|mjs|cjs|jsonl?|rs|pyi?|mdx?|toml|lock|ya?ml|txt|inc|css|s[ac]ss|` +
    String.raw`html?|vue|svelte|go|java|rb|php|swift|kts?|scala|lua|cs|c|cc|cpp|h|hpp)(?:$|[,=:])`,
  "i",
);

export { latencyTelemetrySourceFileExtensionRegex };

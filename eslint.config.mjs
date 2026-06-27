import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Advisory ESLint config for opcore (TypeScript + JS).
//
// Run with `npm run lint:eslint`. This is intentionally NOT wired into `npm run ci`
// yet: the existing Rox, tsc, clippy `-D warnings`, and `cargo fmt --check` gates remain
// the blocking guardrails. ESLint is added advisory-first so violations can be measured
// and cleaned up before any enforcement decision (matches the covibes/orchestra baseline).
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "**/*.d.ts",
      ".claude/**",
      ".ace/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
  },
);

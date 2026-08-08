import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Advisory ESLint config for opcore (TypeScript + JS).
//
// Run with `npm run lint:eslint`. This is intentionally NOT wired into `npm run ci`
// yet: TypeScript, Rust, workspace, provenance, and Opcore self-validation remain
// the blocking guardrails. ESLint is advisory-first so violations can be measured
// and cleaned up before any enforcement decision.
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "**/*.d.ts",
      ".claude/**",
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

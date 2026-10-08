import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "coverage/**", "dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // The core must stay pure: no I/O, no clocks, no randomness, no network.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        "fetch", "process", "require", "XMLHttpRequest", "WebSocket", "setTimeout", "setInterval",
      ],
      "no-restricted-imports": [
        "error",
        { patterns: ["node:*", "fs", "http", "https", "net", "child_process", "@supabase/*"] },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "Core must be deterministic." },
        { object: "Math", property: "random", message: "Core must be deterministic." },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date']", message: "Core must be deterministic." },
      ],
    },
  },
  {
    files: ["eslint.config.js", "vitest.config.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
);

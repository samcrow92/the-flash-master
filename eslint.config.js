import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["out/**", "dist/**", "release/**", "node_modules/**", "**/.venv/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  { files: ["scripts/**/*.mjs", "tests/**/*.mjs"], languageOptions: { globals: { process: "readonly", console: "readonly", setTimeout: "readonly" } } },
);

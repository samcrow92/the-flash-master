import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: { alias: { "@shared": resolve(import.meta.dirname, "src/shared") } },
  test: { include: ["tests/**/*.test.ts"], environment: "node", testTimeout: 15000 },
});

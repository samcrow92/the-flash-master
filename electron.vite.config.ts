import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const shared = { "@shared": resolve(import.meta.dirname, "src/shared") };

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/main/index.ts"),
          // MCP servers shipped with the app and launched by harness sessions.
          "mcp-flashmaster-core": resolve(import.meta.dirname, "mcp-servers/flashmaster-core/server.ts"),
          "mcp-jazz": resolve(import.meta.dirname, "mcp-servers/jazz/server.ts"),
        },
        // .mjs: the MCP entries run unpacked from app.asar.unpacked, where no package.json declares "type": "module".
        output: {
          entryFileNames: (c: { name: string }) => (c.name.startsWith("mcp-") ? "[name].mjs" : "[name].js"),
          chunkFileNames: "chunks/[name]-[hash].mjs",
        },
      },
    },
  },
  preload: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    resolve: { alias: shared },
    plugins: [react()],
    build: { rollupOptions: { input: resolve(import.meta.dirname, "src/renderer/index.html") } },
  },
});

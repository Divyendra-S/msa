import { defineConfig } from "vite";

// The UI in app/ is built to dist/, which the viewer's server serves (no dev server needed).
export default defineConfig({
  root: "app",
  base: "./",
  logLevel: "warn",
  oxc: { jsx: { runtime: "automatic" } },
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 800 },
});

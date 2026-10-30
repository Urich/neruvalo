import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ),
    __BUILD_DIRTY__: JSON.stringify(
      !!execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim(),
    ),
  },
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  build: { target: "es2022" },
});

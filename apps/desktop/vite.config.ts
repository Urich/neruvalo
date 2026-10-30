import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
function buildIdentity() {
  try {
    return {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      dirty: !!execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim(),
    };
  } catch {
    const commit = readFileSync(
      new URL("../../source-version.txt", import.meta.url),
      "utf8",
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(commit))
      throw Error(
        "Build from a git checkout or an exported source archive containing its commit ID.",
      );
    return { commit, dirty: true };
  }
}
const identity = buildIdentity();
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(identity.commit),
    __BUILD_DIRTY__: JSON.stringify(identity.dirty),
  },
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  build: { target: "es2022" },
});

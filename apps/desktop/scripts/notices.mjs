import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root = path.resolve("../..");
const npmLock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--locked", "--all-features", "--format-version", "1"],
    { cwd: root, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
  ),
);
function texts(dir, depth = 0) {
  const result = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      e.isFile() &&
      /^(licen[sc]e|copying|copyright|notice|authors|unlicense)/i.test(e.name)
    ) {
      const content = fs.readFileSync(path.join(dir, e.name), "utf8");
      if (content.length < 2000000)
        result.push({ name: e.name, text: content });
    } else if (
      e.isDirectory() &&
      depth < 2 &&
      /^(licen[sc]es?|legal|notices?)$/i.test(e.name)
    ) {
      result.push(
        ...texts(path.join(dir, e.name), depth + 1).map((t) => ({
          ...t,
          name: e.name + "/" + t.name,
        })),
      );
    }
  }
  return result;
}
const components = metadata.packages
  .filter((p) => p.source)
  .map((p) => ({
    name: p.name,
    version: p.version,
    license: p.license || "See license files",
    source: p.repository || p.source,
    texts: texts(path.dirname(p.manifest_path)),
  }));
function npmPackages(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const packageDir = path.join(dir, e.name);
    if (e.name.startsWith("@")) {
      npmPackages(packageDir);
      continue;
    }
    const file = path.join(packageDir, "package.json");
    if (!fs.existsSync(file)) continue;
    const lockPath = path
      .relative(process.cwd(), packageDir)
      .split(path.sep)
      .join("/");
    if (npmLock.packages[lockPath]?.dev) continue;
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    components.push({
      name: p.name,
      version: p.version,
      license:
        typeof p.license === "string"
          ? p.license
          : JSON.stringify(p.license || p.licenses || "See license files"),
      source: "https://www.npmjs.com/package/" + p.name + "/v/" + p.version,
      texts: texts(packageDir),
    });
    if (fs.existsSync(path.join(packageDir, "node_modules")))
      npmPackages(path.join(packageDir, "node_modules"));
  }
}
npmPackages("node_modules");
const overrides = JSON.parse(
  fs.readFileSync("src/licenses/overrides.json", "utf8"),
);
for (const c of components) {
  if (overrides[c.name + "@" + c.version])
    c.texts.push(...overrides[c.name + "@" + c.version]);
  if (!c.texts.length) {
    const family = c.name.startsWith("@esbuild/")
      ? "esbuild"
      : c.name.startsWith("@rollup/")
        ? "rollup"
        : c.name.startsWith("@tauri-apps/cli-")
          ? "@tauri-apps/cli"
          : c.name.startsWith("@napi-rs/lzma-")
            ? "@napi-rs/lzma"
            : null;
    const parent = components.find(
      (p) => p.name === family && p.version === c.version,
    );
    if (parent) c.texts.push(...parent.texts);
  }
  if (!c.texts.length)
    throw new Error("Missing license notices for " + c.name + "@" + c.version);
}
components.sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
fs.writeFileSync("src/licenses/components.json", JSON.stringify(components));
fs.copyFileSync(path.join(root, "LICENSE"), "src/licenses/AGPL-3.0.txt");
console.log(
  `Bundled license notices for ${components.length} dependency packages (including build tools and supported targets).`,
);

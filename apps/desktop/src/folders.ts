import { Entry } from "./model";
// Paths remain exactly as saved; no rewriting legacy folders or record identities.
export function foldersOf(entries: Entry[]): string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    const path = entry.data.folder;
    if (!path) continue;
    paths.add(path);
    const parts = path.split("/");
    for (let i = 1; i < Math.min(parts.length, 64); i++) {
      const parent = parts.slice(0, i).join("/");
      if (parent) paths.add(parent);
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}
export function inFolder(path: string, filter: string | null): boolean {
  return (
    filter === null ||
    (filter === "" ? !path : path === filter || path.startsWith(filter + "/"))
  );
}

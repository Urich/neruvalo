import { Data, Entry } from "./model";
import { foldersOf } from "./folders";
export type Group = {
  id: string;
  title: string;
  parent_id: string | null;
  legacy_path?: string | null;
  revision?: number;
  archived?: boolean;
};
export function groupsFor(entries: Entry[], saved: Group[]): Group[] {
  const groups = saved.map((g) => ({ ...g }));
  const legacy = new Map(
    groups.filter((g) => g.legacy_path).map((g) => [g.legacy_path!, g.id]),
  );
  const paths = foldersOf(entries.filter((e) => e.data.group_id === undefined));
  for (const path of paths)
    if (!legacy.has(path)) legacy.set(path, "legacy:" + path);
  for (const path of paths)
    if (!saved.some((g) => g.legacy_path === path)) {
      let parent = path.slice(0, path.lastIndexOf("/"));
      if (!path.includes("/")) parent = "";
      groups.push({
        id: legacy.get(path)!,
        title: path.split("/").at(-1) || path,
        parent_id: parent ? (legacy.get(parent) ?? null) : null,
        legacy_path: path,
        archived: entries
          .filter(
            (e) =>
              e.data.group_id === undefined &&
              (e.data.folder === path || e.data.folder.startsWith(path + "/")),
          )
          .every((e) => e.archived),
      });
    }
  const byId = new Map(groups.map((g) => [g.id, g]));
  // Never hide entries or recurse forever if an older/foreign client saved bad links.
  for (const group of groups) {
    const seen = new Set([group.id]);
    let parent = group.parent_id;
    while (parent) {
      if (seen.has(parent) || !byId.has(parent)) {
        group.parent_id = null;
        break;
      }
      seen.add(parent);
      parent = byId.get(parent)!.parent_id;
    }
  }
  return groups;
}
export function parentOf(data: Data, groups: Group[]): string | null {
  if (data.group_id !== undefined)
    return groups.some((g) => g.id === data.group_id) ? data.group_id : null;
  if (!data.folder) return null;
  return groups.find((g) => g.legacy_path === data.folder)?.id ?? null;
}
export function groupLabel(id: string | null, groups: Group[]): string {
  const names: string[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const group = groups.find((g) => g.id === id);
    if (!group) break;
    names.unshift(group.title);
    id = group.parent_id;
  }
  return names.join(" › ");
}
export type TreeNode = {
  key: string;
  group?: Group;
  entry?: Entry;
  children: TreeNode[];
};
export function entryTree(
  groups: Group[],
  entries: Entry[],
  query: string,
  kind: string,
  archive: boolean,
  hideEmpty = false,
): TreeNode[] {
  const q = query.trim().toLocaleLowerCase();
  const nodes = new Map<string, TreeNode>(
    groups.map((g) => [g.id, { key: g.id, group: g, children: [] }]),
  );
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.group!.parent_id;
    const target = parent ? nodes.get(parent)?.children : undefined;
    (target ?? roots).push(node);
  }
  for (const entry of entries)
    if (
      entry.archived === archive &&
      (!kind || entry.data.record_type === kind)
    ) {
      const node = { key: entry.record_id, entry, children: [] };
      const parent = parentOf(entry.data, groups);
      (parent ? nodes.get(parent)!.children : roots).push(node);
    }
  const filter = (list: TreeNode[], ancestorMatch = false): TreeNode[] =>
    list
      .flatMap((node) => {
        const match =
          !q ||
          ancestorMatch ||
          [
            node.group?.title ?? node.entry!.data.title,
            ...(node.entry?.data.tags ?? []),
          ].some((s) => s.toLocaleLowerCase().includes(q));
        const children = filter(node.children, match);
        if (
          node.group &&
          !children.length &&
          (kind || hideEmpty || !!node.group.archived !== archive)
        )
          return [];
        return match || children.length ? [{ ...node, children }] : [];
      })
      .sort(
        (a, b) =>
          Number(!!b.group) - Number(!!a.group) ||
          (a.group?.title ?? a.entry!.data.title).localeCompare(
            b.group?.title ?? b.entry!.data.title,
          ),
      );
  return filter(roots);
}

export function archiveSelection(
  id: string,
  groups: Group[],
  entries: Entry[],
  archived: boolean,
) {
  const ids = new Set([id]);
  for (let pass = 0; pass <= groups.length; pass++) {
    const before = ids.size;
    for (const g of groups)
      if (g.parent_id && ids.has(g.parent_id)) ids.add(g.id);
    if (ids.size === before) break;
  }
  const records = entries.filter(
    (e) => ids.has(e.record_id) || ids.has(parentOf(e.data, groups) ?? ""),
  );
  const parents = new Set<string>();
  if (!archived) {
    for (const item of [
      ...groups.filter((g) => ids.has(g.id)).map((g) => g.parent_id),
      ...records.map((e) => parentOf(e.data, groups)),
    ]) {
      let p = item;
      const seen = new Set<string>();
      while (p && !seen.has(p)) {
        seen.add(p);
        parents.add(p);
        p = groups.find((g) => g.id === p)?.parent_id ?? null;
      }
    }
  }
  return {
    records: records.filter((e) => e.archived !== archived).length,
    groups: groups.filter(
      (g) => (ids.has(g.id) || parents.has(g.id)) && !!g.archived !== archived,
    ).length,
    unchanged: records.filter((e) => e.archived === archived).length,
  };
}

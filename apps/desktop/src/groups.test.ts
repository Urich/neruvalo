import { describe, it, expect } from "vitest";
import {
  groupsFor,
  entryTree,
  parentOf,
  groupLabel,
  archiveSelection,
  Group,
  TreeNode,
} from "./groups";
import { empty, Entry } from "./model";
const record = (
  id: string,
  type: string,
  group: string | null | undefined,
  folder = "",
): Entry => ({
  record_id: id,
  version_id: id,
  revision: 1,
  archived: false,
  data: {
    ...empty(type),
    title: id,
    folder,
    ...(group !== undefined ? { group_id: group } : {}),
  },
});
const keys = (nodes: TreeNode[]): string[] =>
  nodes.flatMap((n) => [n.key, ...keys(n.children)]);
describe("encrypted group tree projection", () => {
  it("keeps empty groups and mixed-type descendants under the same parents", () => {
    const groups: Group[] = [
      { id: "bank", title: "Bank", parent_id: null },
      { id: "cards", title: "Cards", parent_id: "bank" },
      { id: "empty", title: "Empty", parent_id: null },
    ];
    const entries = [
      record("card", "bank_card", "cards"),
      record("note", "note", "bank"),
      record("root", "login", null),
    ];
    const tree = entryTree(groups, entries, "", "", false);
    expect(
      tree.find((n) => n.key === "bank")!.children.map((n) => n.key),
    ).toEqual(["cards", "note"]);
    expect(keys(tree)).toContain("empty");
    const filtered = entryTree(groups, entries, "", "note", false);
    expect(keys(filtered)).toEqual(["bank", "note"]);
    expect(keys(entryTree(groups, entries, "card", "", false))).toEqual([
      "bank",
      "cards",
      "card",
    ]);
    expect(groupLabel("cards", groups)).toBe("Bank › Cards");
  });
  it("projects legacy paths without rewriting records and joins materialized nodes", () => {
    const entry = record("old", "login", undefined, "Bank/Cards");
    const before = JSON.stringify(entry);
    const saved: Group[] = [
      { id: "real-bank", title: "Bank", parent_id: null, legacy_path: "Bank" },
    ];
    const groups = groupsFor([entry], saved);
    expect(groups.find((g) => g.id === "legacy:Bank/Cards")?.parent_id).toBe(
      "real-bank",
    );
    expect(parentOf(entry.data, groups)).toBe("legacy:Bank/Cards");
    expect(JSON.stringify(entry)).toBe(before);
    expect(parentOf({ ...entry.data, group_id: null }, groups)).toBeNull();
  });
  it("does not lose entries or recurse forever on missing parents or cycles", () => {
    const groups = groupsFor(
      [],
      [
        { id: "a", title: "A", parent_id: "b" },
        { id: "b", title: "B", parent_id: "a" },
        { id: "c", title: "C", parent_id: "missing" },
      ],
    );
    const tree = entryTree(
      groups,
      [record("orphan", "note", "missing")],
      "",
      "",
      false,
    );
    expect(keys(tree).sort()).toEqual(["a", "b", "c", "orphan"]);
  });
});

describe("archive views", () => {
  it("keeps active ancestors as context in the archive and hides empty groups for a type filter", () => {
    const groups: Group[] = [
      { id: "root", title: "Root", parent_id: null, archived: false },
      { id: "old", title: "Old", parent_id: "root", archived: true },
      { id: "empty", title: "Empty", parent_id: "root", archived: true },
    ];
    const active = record("active", "note", "root");
    const old = { ...record("card", "bank_card", "old"), archived: true };
    expect(keys(entryTree(groups, [active, old], "", "", false))).toEqual([
      "root",
      "active",
    ]);
    expect(keys(entryTree(groups, [active, old], "", "", true))).toEqual([
      "root",
      "empty",
      "old",
      "card",
    ]);
    expect(
      keys(entryTree(groups, [active, old], "", "bank_card", true)),
    ).toEqual(["root", "old", "card"]);
    expect(
      keys(entryTree(groups, [active, old], "Root", "note", true)),
    ).toEqual([]);
    expect(archiveSelection("root", groups, [active, old], true)).toEqual({
      records: 1,
      groups: 1,
      unchanged: 1,
    });
    expect(archiveSelection("card", groups, [active, old], false)).toEqual({
      records: 1,
      groups: 1,
      unchanged: 0,
    });
  });
});

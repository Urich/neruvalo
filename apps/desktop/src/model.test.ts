import { describe, it, expect } from "vitest";
import { empty, filterEntries, errorText, Entry, types } from "./model";
describe("vault view rules", () => {
  it("never exposes archived entries in the active list", () => {
    const a: Entry = {
      record_id: "a",
      version_id: "1",
      revision: 1,
      archived: true,
      data: { ...empty(), title: "Mail" },
    };
    expect(filterEntries([a], "", "", false)).toEqual([]);
    expect(filterEntries([a], "mail", "", true)).toEqual([a]);
  });
  it("maps the exact agreed conflict message", () =>
    expect(errorText("RECORD_VERSION_MISMATCH")).toBe(
      "Запись изменена на другом устройстве. Синхронизируйте устройства.",
    ));
  it("contains all eight agreed types and sensitive card fields", () => {
    expect(Object.keys(types)).toHaveLength(8);
    for (const field of ["cvv", "pin"])
      expect(types.bank_card.fields.find((f) => f[0] === field)?.[2]).toBe(
        true,
      );
  });
});

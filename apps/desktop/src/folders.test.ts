import { describe, it, expect } from "vitest";
import { foldersOf, inFolder } from "./folders";
import { empty, Entry } from "./model";
import { fieldsOf } from "./documents";
import { fromEvent, sameShortcut, defaultShortcuts } from "./preferences";
describe("folders and interoperable documents", () => {
  it("derives mixed-type parent folders without modifying stored paths", () => {
    const entries = ["bank_card", "note", "document"].map(
      (type, i) =>
        ({
          data: { ...empty(type), folder: i ? "Banks/A/Cards" : "Banks/A" },
        }) as Entry,
    );
    expect(foldersOf(entries)).toEqual(["Banks", "Banks/A", "Banks/A/Cards"]);
    expect(inFolder("Banks/A/Cards", "Banks/A")).toBe(true);
    expect(inFolder("Banks/Another", "Banks/A")).toBe(false);
    expect(inFolder("", "")).toBe(true);
    expect(inFolder("Banks", null)).toBe(true);
  });
  it("preserves legacy and user-defined document fields and masks unknown values", () => {
    const fields = fieldsOf({
      ...empty("document"),
      fields: {
        legacy: "001",
        "custom:License class": "B",
        template: "driver_license",
      },
    });
    expect(fields.find((f) => f[0] === "legacy")?.[2]).toBe(true);
    expect(fields.find((f) => f[0] === "custom:License class")).toEqual([
      "custom:License class",
      "License class",
      true,
      false,
    ]);
    expect(fields.some((f) => f[0] === "template")).toBe(false);
    expect(fields.some((f) => f[0] === "country")).toBe(true);
  });
});
describe("physical-key shortcut safety", () => {
  const event = (value: Partial<KeyboardEvent>) =>
    ({
      code: "KeyU",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      getModifierState: () => false,
      ...value,
    }) as KeyboardEvent;
  it("works independently of the character produced by a keyboard layout", () => {
    expect(
      sameShortcut(fromEvent(event({ key: "Г" })), defaultShortcuts.login),
    ).toBe(true);
  });
  it("rejects ordinary editing, OS/meta keys and unmodified characters", () => {
    expect(fromEvent(event({ code: "KeyC", shiftKey: false }))).toBeNull();
    expect(fromEvent(event({ metaKey: true }))).toBeNull();
    expect(fromEvent(event({ ctrlKey: false, shiftKey: false }))).toBeNull();
    expect(fromEvent(event({ code: "F4", altKey: true }))).toBeNull();
  });
});

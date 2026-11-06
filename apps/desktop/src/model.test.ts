import { describe, it, expect } from "vitest";
import { empty, filterEntries, errorText, Entry, types } from "./model";
describe("vault view rules", () => {
  it("returns a translation key for invalid proxy settings", () => {
    expect(errorText(new Error("INVALID_PROXY_CONFIG"))).toBe(
      "ui.couldNotSaveProxySettingsCheckTheProxyAddressAndType",
    );
  });
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
      "ui.thisEntryWasChangedOnAnotherDeviceSynchronizeYourDevices",
    ));
  it("contains all eight agreed types and sensitive card fields", () => {
    expect(Object.keys(types)).toHaveLength(8);
    for (const field of ["cvv", "pin"])
      expect(types.bank_card.fields.find((f) => f[0] === field)?.[2]).toBe(
        true,
      );
  });
});

describe("localized error boundary", () => {
  it.each([
    "incorrect secret or damaged data", new Error("incorrect secret or damaged data"), "Error: INVALID_PASSWORD",
  ])("maps decryption and password errors to a translation key", (error) => {
    expect(errorText(error)).toBe("ui.incorrectPasswordOrDamagedData");
  });
  it.each(["request failed at http://localhost:8787", "database is locked (os error 5)", "UNRECOGNIZED: details", "ui.unknownKey"])("never exposes raw backend text: %s", (error) => {
    expect(errorText(error)).toBe("ui.operationFailedCheckYourConnectionAndTryAgain");
  });
  it("retains known translation keys", () => {
    expect(errorText(new Error("ui.saveTheRecoveryFileFirst"))).toBe("ui.saveTheRecoveryFileFirst");
  });
});

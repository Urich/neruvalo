import { describe, it, expect } from "vitest";
import { empty, filterEntries, errorText, Entry, types, passwordExpired, isUnsupportedVaultFormat } from "./model";
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

describe("password expiry", () => {
  it("uses the exact expiry instant and respects no-expiry settings", () => {
    const data = {...empty(),fields:{expires:"2030-01-01T12:00:00Z"}};
    expect(passwordExpired(data,Date.parse("2030-01-01T11:59:59Z"))).toBe(false);
    expect(passwordExpired(data,Date.parse("2030-01-01T12:00:00Z"))).toBe(true);
    expect(passwordExpired({...data,fields:{...data.fields,never_expires:"true"}},Date.parse("2031-01-01"))).toBe(false);
    expect(passwordExpired({...data,fields:{expires:"invalid"}})).toBe(false);
    expect(passwordExpired(empty())).toBe(false);
  });
});


describe("vault format errors", () => {
  it.each(["UNSUPPORTED_LOCAL_SCHEMA", "UNSUPPORTED_VAULT_FORMAT", "UNSUPPORTED_PROTOCOL", "UNSUPPORTED_FORMAT", "UNSUPPORTED_ATTACHMENT_FORMAT", "unsupported envelope"])("recognizes %s without exposing backend details", error => {
    expect(isUnsupportedVaultFormat(new Error(error))).toBe(true);
    expect(errorText(error)).toBe("ui.unsupportedVaultFormat");
  });
  it.each(["KEEPASS_UNSUPPORTED_VERSION", "UNSUPPORTED_BACKUP", "UNSUPPORTED_CERTIFICATE", "AUTH_FAILED"])("keeps unrelated errors separate: %s", error => {
    expect(isUnsupportedVaultFormat(error)).toBe(false);
  });
});

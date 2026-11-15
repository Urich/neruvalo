// @vitest-environment jsdom
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TotpDisplay, TotpEditor } from "./Totp";
import { empty, Entry } from "./model";
import { setPreference } from "./i18n";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, host: HTMLDivElement, visibility = "visible";
const entry: Entry = { record_id: "entry", version_id: "v1", revision: 1, archived: false, data: { ...empty(), title: "Account", fields: { totp: "JBSWY3DPEHPK3PXP" } } };
const config = { secret: "JBSWY3DPEHPK3PXP", issuer: "Example", account: "alice", algorithm: "SHA1", digits: 6, period: 30 };
function code() { const now = Math.floor(Date.now() / 1000); return { code: now < 60 ? "012345" : "678901", generated_at: now, valid_until: (Math.floor(now / 30) + 1) * 30, period: 30 }; }
beforeEach(() => {
    setPreference("en");
    vi.useFakeTimers();
    vi.setSystemTime(59000);
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    native.invoke.mockReset().mockImplementation(async (_, { request }) => {
        if (request.action === "totp_code")
            return code();
        if (request.action === "totp_preview")
            return { uri: "otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP", code: code(), qr: "data:image/svg+xml;base64,AAAA" };
        if (request.action === "totp_qr")
            return "data:image/svg+xml;base64,AAAA";
        if (request.action === "totp_qr_import" || request.action === "totp_parse")
            return { config };
        return null;
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
async function click(text: string) { await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === text)!.click()); }
async function mountDisplay() { await act(async () => root.render(<TotpDisplay entry={entry} profile="profile" clipboardSeconds={30}/>)); }
it("preserves leading zeros, updates at the boundary and copies through fresh native generation", async () => {
    await mountDisplay();
    expect(host.textContent).toContain("012 345");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(host.textContent).toContain("678 901");
    await click("Copy");
    expect(native.invoke).toHaveBeenCalledWith("command", { request: { action: "copy_field", expected_profile: "profile", id: "entry", expected_version: "v1", field: "totp_code", seconds: 30 } });
});
it("clears stale tokens in the background and stops requests on unmount", async () => {
    await mountDisplay();
    await act(async () => { visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); });
    expect(host.textContent).not.toContain("012 345");
    await act(async () => { vi.setSystemTime(120000); visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
    expect(host.textContent).toContain("678 901");
    await act(async () => root.render(<div />));
    const count = native.invoke.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(native.invoke.mock.calls).toHaveLength(count);
});
it("exports QR only after an explicit action and can hide it", async () => {
    await mountDisplay();
    expect(host.querySelector(".totp-qr")).toBeNull();
    expect(native.invoke.mock.calls.some(([, args]) => args.request.action === "totp_qr")).toBe(false);
    await click("Show QR code");
    expect(host.querySelector(".totp-qr")).not.toBeNull();
    await click("Hide QR code");
    expect(host.querySelector(".totp-qr")).toBeNull();
});
it("validates draft settings, imports QR settings and does not mutate an unchanged entry", async () => {
    const changed = vi.fn(), valid = vi.fn();
    await act(async () => root.render(<TotpEditor value="otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP" profile="profile" onChange={changed} onValidity={valid}/>));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(changed).not.toHaveBeenCalled();
    expect(valid).toHaveBeenLastCalledWith(true);
    await click("Import QR image");
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(changed).toHaveBeenCalledWith(expect.stringContaining("otpauth://"));
    await click("Remove TOTP");
    expect(changed).toHaveBeenLastCalledWith("");
    expect(valid).toHaveBeenLastCalledWith(true);
});
it("blocks invalid settings and clears an expired token while its refresh is pending", async () => {
    const changed = vi.fn(), valid = vi.fn();
    native.invoke.mockRejectedValueOnce(Error("INVALID_TOTP"));
    await act(async () => root.render(<TotpEditor value="INVALID" profile="profile" onChange={changed} onValidity={valid}/>));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(changed).not.toHaveBeenCalled();
    expect(valid).toHaveBeenLastCalledWith(false);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => root.render(<TotpDisplay entry={entry} profile="profile" clipboardSeconds={30}/>));
    native.invoke.mockImplementationOnce(() => new Promise(() => { }));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(host.textContent).not.toContain("012 345");
});

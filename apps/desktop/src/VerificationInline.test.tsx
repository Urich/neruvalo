// @vitest-environment jsdom
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VerificationInline } from "./VerificationInline";
import { setPreference } from "./i18n";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperties(HTMLDialogElement.prototype, {
  show: { configurable: true, value() { this.open = true; } },
  showModal: { configurable: true, value() { this.open = true; this.dataset.modal = "true"; } },
  close: { configurable: true, value() { this.open = false; delete this.dataset.modal; } },
});
let root: Root, host: HTMLDivElement;
const ready = vi.fn();
const prepared = { enabled: true, secret: "a".repeat(43), url: "https://vault.example/verification#secret" };
async function render(login = "alice", kind: "register" | "login" = "login") {
  await act(async () => root.render(<VerificationInline server="https://vault.example" login={login}
    email={kind === "register" ? "a@example.test" : ""} kind={kind} onReady={ready} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
}
async function message(state: string, origin = "https://vault.example", source?: Window | null) {
  await act(async () => window.dispatchEvent(new MessageEvent("message", {
    origin, source: source === undefined ? host.querySelector("iframe")!.contentWindow : source,
    data: { type: "neruvalo-verification", state },
  })));
}
beforeEach(() => {
  vi.useFakeTimers(); ready.mockReset(); native.invoke.mockReset().mockResolvedValue(prepared);
  setPreference("ru"); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
it.each(["register", "login"] as const)("prepares %s, embeds the checkbox and keeps its frame when images are required", async (kind) => {
  await render("alice", kind);
  expect(native.invoke).toHaveBeenCalledWith("command", { request: {
    action: "prepare_verification", server: "https://vault.example", login: "alice", kind,
    email: kind === "register" ? "a@example.test" : "",
  }});
  const frame = host.querySelector("iframe")!;
  expect(new URL(frame.src).searchParams.get("lang")).toBe("ru");
  expect(host.querySelector("dialog")?.className).toBe("verification-checkbox");
  await message("visual", "https://attacker.example");
  await message("visual", "https://vault.example", window);
  expect(host.querySelector("dialog")?.dataset.modal).toBeUndefined();
  await message("visual");
  expect(host.querySelector("dialog")?.dataset.modal).toBe("true");
  expect(host.querySelector("iframe")).toBe(frame);
  await message("verified");
  expect(ready).toHaveBeenLastCalledWith(prepared.secret);
  expect(host.querySelector("dialog")?.dataset.modal).toBeUndefined();
});
it("invalidates successful checks after identity changes and expiration", async () => {
  await render(); await message("verified");
  await render("bob"); expect(ready).toHaveBeenLastCalledWith(null);
  await message("verified");
  await act(async () => { await vi.advanceTimersByTimeAsync(165000); });
  expect(ready).toHaveBeenLastCalledWith(null);
});
it("allows submission without a widget when the server has no GateVeriq", async () => {
  native.invoke.mockResolvedValue({ enabled: false }); await render();
  expect(ready).toHaveBeenLastCalledWith(""); expect(host.querySelector("iframe")).toBeNull();
});
it("keeps failures blocked and offers retry", async () => {
  native.invoke.mockRejectedValue(new Error("offline")); await render();
  expect(ready).toHaveBeenLastCalledWith(null); expect(host.querySelector('[role="alert"]')).not.toBeNull();
  native.invoke.mockResolvedValue(prepared);
  await act(async () => host.querySelector("button")!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(host.querySelector("iframe")).not.toBeNull();
});

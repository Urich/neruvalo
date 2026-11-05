// @vitest-environment jsdom
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VerificationDialog } from "./VerificationDialog";
import { setPreference, setSystemLocale } from "./i18n";

const native = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: any }) => void>(),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name, callback) => {
    native.handlers.set(name, callback);
    return () => native.handlers.delete(name);
  }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value() { this.open = true; } },
  close: { configurable: true, value() { this.open = false; } },
});
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  native.handlers.clear();
  native.invoke.mockReset().mockResolvedValue(null);
  setPreference("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<VerificationDialog />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function emit(name: string, payload: unknown) {
  await act(async () => native.handlers.get(name)!({ payload }));
}
const attempt = { id: "1", url: "http://127.0.0.1:8787/verification#secret" };

it("embeds the challenge in a sandbox and closes only the matching attempt", async () => {
  await emit("verification-open", attempt);
  expect(host.querySelector("dialog")?.open).toBe(true);
  const frame = host.querySelector("iframe")!;
  const url = new URL(frame.src);
  expect(url.hash).toBe("#secret");
  expect(url.searchParams.get("embedded")).toBe("1");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  await emit("verification-close", "old-attempt");
  expect(host.querySelector("dialog")).not.toBeNull();
  await emit("verification-close", "1");
  expect(host.querySelector("dialog")).toBeNull();
});

it("cancels through the independent command and restores focus", async () => {
  const previous = document.createElement("button");
  document.body.append(previous);
  previous.focus();
  await emit("verification-open", attempt);
  await act(async () => host.querySelector("button")!.click());
  expect(native.invoke).toHaveBeenCalledWith("cancel_verification", { id: "1" });
  expect(host.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(previous);
  previous.remove();
});

it("ignores non-server URLs and keeps cancellation errors recoverable", async () => {
  await emit("verification-open", { ...attempt, url: "javascript:alert(1)" });
  expect(host.querySelector("iframe")).toBeNull();
  await emit("verification-open", attempt);
  native.invoke.mockRejectedValueOnce(new Error("offline"));
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector("dialog")).not.toBeNull();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

it.each(["ru", "de", "zh-Hant"])("uses the current application language %s for verification", async (language) => {
  await act(async () => setPreference(language));
  await emit("verification-open", attempt);
  expect(new URL(host.querySelector("iframe")!.src).searchParams.get("lang")).toBe(language);
});

it("uses the resolved system language in automatic mode", async () => {
  await act(async () => {
    setSystemLocale("ru-RU");
    setPreference("auto");
  });
  await emit("verification-open", attempt);
  expect(new URL(host.querySelector("iframe")!.src).searchParams.get("lang")).toBe("ru");
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VerificationFrame } from "./VerificationFrame";
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
  showModal: { configurable: true, value() { this.open = true; this.dataset.modal = "true"; } },
  close: { configurable: true, value() { this.open = false; delete this.dataset.modal; } },
});
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  native.handlers.clear();
  native.invoke.mockReset().mockResolvedValue(null);
  setPreference("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<VerificationFrame target={host} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete document.documentElement.dataset.theme;
});
async function emit(name: string, payload: unknown) {
  await act(async () => native.handlers.get(name)!({ payload }));
}
const attempt = { id: "1", url: "http://127.0.0.1:8787/verification#secret" };
async function message(state: string, origin = new URL(attempt.url).origin, source = host.querySelector("iframe")!.contentWindow) {
  await act(async () => window.dispatchEvent(new MessageEvent("message", {
    origin, source, data: { type: "neruvalo-verification", state },
  })));
}

it("embeds the challenge in a sandbox and closes only the matching attempt", async () => {
  await emit("verification-open", attempt);
  const frame = host.querySelector("iframe")!;
  const url = new URL(frame.src);
  expect(url.hash).toBe("#secret");
  expect(url.searchParams.get("embedded")).toBe("1");
  expect(url.searchParams.get("inline")).toBe("1");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  expect(frame.closest("dialog")?.open).toBe(true);
  expect(frame.closest("dialog")?.dataset.modal).toBeUndefined();
  expect(host.querySelector("h2, button, footer")).toBeNull();
  await emit("verification-close", "old-attempt");
  expect(host.querySelector("iframe")).toBe(frame);
  await emit("verification-close", "1");
  expect(host.querySelector("iframe")).toBeNull();
});

it("accepts progress and visual challenges only from the active frame", async () => {
  await emit("verification-open", attempt);
  const frame = host.querySelector("iframe")!;
  const dialog = frame.closest("dialog")!;
  const frameWindow = frame.contentWindow;
  await message("checking", "https://other.example");
  await message("checking", new URL(attempt.url).origin, window);
  expect(frame.hidden).toBe(false);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("");
  await message("checking");
  expect(frame.hidden).toBe(true);
  expect(dialog.open).toBe(false);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Checking…");
  await message("visual");
  expect(host.querySelector("iframe")).toBe(frame);
  expect(frame.contentWindow).toBe(frameWindow);
  expect(frame.hidden).toBe(false);
  expect(dialog.dataset.modal).toBe("true");
  await message("verified");
  expect(dialog.open).toBe(false);
});

it("ignores non-server URLs and keeps cancellation errors recoverable", async () => {
  await emit("verification-open", { ...attempt, url: "javascript:alert(1)" });
  expect(host.querySelector("iframe")).toBeNull();
  await emit("verification-open", attempt);
  native.invoke.mockRejectedValueOnce(new Error("offline"));
  await message("cancel");
  expect(host.querySelector("iframe")).not.toBeNull();
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

it("passes the active theme to the frame", async () => {
  document.documentElement.dataset.theme = "dark-green";
  await emit("verification-open", attempt);
  const frame = host.querySelector("iframe")!;
  expect(new URL(frame.src).searchParams.get("theme")).toBe("dark-green");
  expect(frame.closest("dialog")?.dataset.modal).toBeUndefined();
});

it("accepts keyboard cancellation only from the active frame", async () => {
  await emit("verification-open", attempt);
  await message("cancel", new URL(attempt.url).origin, window);
  expect(native.invoke).not.toHaveBeenCalled();
  await message("cancel");
  expect(native.invoke).toHaveBeenCalledWith("cancel_verification", { id: attempt.id });
  expect(host.querySelector("iframe")).toBeNull();
});

it("cancels the active slider from the modal's button", async () => {
  await emit("verification-open", attempt);
  await message("visual");
  const dialog = host.querySelector("dialog")!;
  await act(async () => dialog.querySelector("button")!.click());
  expect(native.invoke).toHaveBeenCalledWith("cancel_verification", { id: attempt.id });
  expect(host.querySelector("iframe")).toBeNull();
});

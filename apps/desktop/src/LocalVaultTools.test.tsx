// @vitest-environment jsdom
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalVaultTools } from "./LocalVaultTools";
import { setPreference, translate } from "./i18n";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value() { this.open = true; } },
  close: { configurable: true, value() { this.open = false; } },
});
let root: Root, host: HTMLDivElement;
const changed = vi.fn(), source = vi.fn(), connect = vi.fn();
beforeEach(() => {
  setPreference("en"); native.invoke.mockReset().mockResolvedValue({ local: true });
  changed.mockReset().mockResolvedValue(null); source.mockReset(); connect.mockReset().mockResolvedValue(null);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function mount(status = { unlocked: false } as {unlocked:boolean;local?:boolean;online?:boolean;profile?:string}, selected = "") {
  await act(async () => root.render(<LocalVaultTools status={status} profiles={[{id:"local-1",login:"Personal",server:"",local:true}]}
    importsOnly={!!selected} source={selected} onSource={source} onChanged={changed} onConnect={connect} />));
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
  await act(async () => button.click());
}
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", {bubbles:true}));
  });
}
it("creates a local vault with matching passwords without server verification", async () => {
  await mount(); await click("Create local vault");
  const inputs = host.querySelectorAll<HTMLInputElement>("dialog input");
  await fill(inputs[0], "Personal"); await fill(inputs[1], "local-password-123");
  expect(host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  await fill(inputs[2], "local-password-123");
  await act(async () => host.querySelector<HTMLButtonElement>('[type="submit"]')!.click());
  expect(native.invoke).toHaveBeenCalledTimes(1);
  expect(native.invoke).toHaveBeenCalledWith("command", {request: {
    action:"create_local",expected_profile:undefined,name:"Personal",password:"local-password-123",source_id:"",
  }});
  expect(changed).toHaveBeenCalledOnce(); expect(host.querySelector("iframe")).toBeNull();
});
it("exposes backups and connection for a local profile", async () => {
  await mount({unlocked:true,local:true,online:false,profile:"local-1"});
  await click("Connect to a server");
  expect(connect).not.toHaveBeenCalled();
  expect(host.querySelector("dialog")!.textContent).toContain("Sign in or create a server account.");
  expect(host.querySelector('dialog input[type="password"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[type="submit"]')!.click());
  expect(connect).toHaveBeenCalledOnce();
  await click("Save encrypted backup");
  await fill(host.querySelector<HTMLInputElement>('dialog input[type="password"]')!, "local-password-123");
  await act(async () => host.querySelector<HTMLButtonElement>('[type="submit"]')!.click());
  expect(native.invoke.mock.calls[0][1].request.action).toBe("export_local_backup");
  expect(native.invoke.mock.calls[0][1].request.expected_profile).toBe("local-1");
});
it("confirms a transfer after server sign-in and keeps failed transfers retryable", async () => {
  await mount({unlocked:true,online:true,profile:"server-1"}, "local-1");
  expect(host.querySelector("dialog")?.open).toBe(true);
  await fill(host.querySelector<HTMLInputElement>('dialog input[type="password"]')!, "local-password-123");
  native.invoke.mockRejectedValueOnce(new Error("connection lost"));
  await act(async () => host.querySelector<HTMLButtonElement>('[type="submit"]')!.click());
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(source).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('[type="submit"]')!.click());
  expect(native.invoke.mock.calls[1][1].request.source_id).toBe("local-1");
  expect(source).toHaveBeenCalledWith("");
});
it("restores a backup through the native picker", async () => {
  await mount(); await click("Restore from backup");
  await fill(host.querySelector<HTMLInputElement>('dialog input[type="password"]')!, "local-password-123");
  await act(async () => host.querySelector<HTMLButtonElement>('[type="submit"]')!.click());
  expect(native.invoke.mock.calls[0][1].request.action).toBe("restore_local_backup");
  expect(changed).toHaveBeenCalledOnce();
});

it("does not show transfer instructions on the sign-in form", async () => {
  await mount({unlocked:false}, "local-1");
  expect(host.textContent).not.toContain("Sign in or create a server account.");
});

it("translates password failures and updates messages when the application locale changes", async () => {
  await mount(); await click("Restore from backup");
  await fill(host.querySelector<HTMLInputElement>('dialog input[type="password"]')!, "wrong-password");
  native.invoke.mockRejectedValueOnce(new Error("incorrect secret or damaged data"));
  await act(async () => host.querySelector<HTMLButtonElement>('[type="submit"]')!.click());
  await act(async () => setPreference("ru"));
  expect(host.querySelector('[role="alert"]')!.textContent).toBe(translate("ui.incorrectPasswordOrDamagedData", "ru"));
  expect(host.textContent).not.toContain("incorrect secret or damaged data");
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KeepassImport, KeepassReport } from "./KeepassImport";
import { setPreference } from "./i18n";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value() { this.open = true; } },
  close: { configurable: true, value() { this.open = false; } },
});
const preview: KeepassReport = { ticket:"ticket", folder:"Imported", entries:2, groups:3, attachments:1,
  archived:1, history_versions:4, can_confirm:true, dispatched:false,
  issues:[{code:"history",item:"",blocking:false}] };
let root: Root, host: HTMLDivElement;
const changed = vi.fn();
beforeEach(() => {
  setPreference("en"); changed.mockReset().mockResolvedValue(null);
  native.invoke.mockReset().mockImplementation(async (_command, {request}) => {
    if (request.action === "keepass_status" || request.action === "keepass_last_report") return null;
    if (request.action === "keepass_prepare") return preview;
    return true;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function mount() { await act(async () => root.render(<KeepassImport profile="alice" disabled={false} onChanged={changed} />)); }
async function click(text: string) { await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === text)!.click()); }
async function fillPassword(value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", {bubbles:true}));
  });
}
async function submit() { await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles:true,cancelable:true}))); }
it("previews before explicit confirmation, clears the source password and binds every call to the profile", async () => {
  await mount(); expect(host.querySelector("dialog")).toBeNull(); await fillPassword("source-password"); await submit();
  expect(native.invoke).toHaveBeenCalledWith("command", {request: {action:"keepass_prepare",expected_profile:"alice",folder:"KeePass",password:"source-password",use_keyfile:false}});
  expect(host.textContent).toContain("History versions excluded");
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(native.invoke.mock.calls.some(([, args]) => args.request.action === "keepass_commit")).toBe(false);
  await click("Confirm import");
  expect(native.invoke).toHaveBeenCalledWith("command", {request:{action:"keepass_commit",expected_profile:"alice",ticket:"ticket"}});
  expect(changed).toHaveBeenCalledOnce(); expect(host.querySelector("dialog")).toBeNull();
  expect(host.textContent).not.toContain("KeePass import completed.");
  expect(host.textContent).toContain("Import result");
});
it("allows keyfile-only opening and handles native selection cancellation", async () => {
  await mount();
  expect(host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  await act(async () => host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());
  expect(host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false);
  native.invoke.mockResolvedValueOnce(null); await submit();
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
  expect(changed).not.toHaveBeenCalled();
  expect(native.invoke.mock.calls.at(-1)![1].request.use_keyfile).toBe(true);
});
it("blocks confirmation for rejected attachments and cancels the prepared operation", async () => {
  native.invoke.mockImplementation(async () => ({...preview,can_confirm:false,issues:[{code:"attachment_limit",item:"<img src=x onerror=alert(1)>",blocking:true}]}));
  await mount();
  expect([...host.querySelectorAll("button")].find(b => b.textContent === "Confirm import")!.disabled).toBe(true);
  expect(host.textContent).not.toContain("<img");
  expect(host.querySelector("img")).toBeNull();
  await click("Cancel");
  expect(native.invoke).toHaveBeenCalledWith("command", {request:{action:"keepass_cancel",expected_profile:"alice",ticket:"ticket"}});
});

it("opens the detailed HTML report through the native browser command while showing only a summary on the page", async () => {
  const details = {code:"entry_metadata",item:"Private entry name",field:"AutoType",source_id:"source-id",group_path:["Private group"],blocking:false};
  native.invoke.mockImplementation(async (_command, {request}) => request.action === "keepass_status" ? {...preview,issues:[details]} : true);
  await mount();
  expect(host.querySelector("dialog")).toBeNull();
  expect(host.textContent).not.toContain(details.item);
  expect(host.textContent).not.toContain(details.field);
  await click("Open HTML report");
  expect(native.invoke).toHaveBeenCalledWith("command", {request:{action:"keepass_open_report",expected_profile:"alice",ticket:"ticket",labels:expect.objectContaining({language:"en",reportField:"Field / attachment",reportSourceId:"Source ID"})}});
  expect(changed).not.toHaveBeenCalled();
});

it("retains the completed report on returning to the page and permits a new import", async () => {
  native.invoke.mockImplementation(async (_command, {request}) => {
    if (request.action === "keepass_status") return null;
    if (request.action === "keepass_last_report") return {...preview,completed:true};
    return true;
  });
  await mount();
  expect(host.textContent).toContain("Import result");
  expect(host.textContent).not.toContain("Confirm import");
  await click("Open HTML report");
  await click("New import");
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
  expect(native.invoke.mock.calls.some(([, args]) => args.request.action === "keepass_cancel")).toBe(false);
});
it("resumes uncertain imports on the page with the same ticket", async () => {
  native.invoke.mockImplementation(async () => ({...preview,dispatched:true}));
  await mount();
  expect(host.textContent).toContain("without duplicates");
  expect(host.querySelector("dialog")).toBeNull();
  expect(host.textContent).not.toContain("Cancel");
  await click("Retry same import");
  expect(native.invoke).toHaveBeenCalledWith("command", {request:{action:"keepass_commit",expected_profile:"alice",ticket:"ticket"}});
});
it("keeps the report after a failed commit and reloads its durable dispatch state", async () => {
  let failed = false;
  native.invoke.mockImplementation(async (_command, {request}) => {
    if (request.action === "keepass_last_report") return null;
    if (request.action === "keepass_status") return failed ? {...preview,dispatched:true} : null;
    if (request.action === "keepass_prepare") return preview;
    if (request.action === "keepass_commit") { failed = true; throw Error("KEEPASS_IMPORT_UNCERTAIN"); }
    return true;
  });
  await mount(); await fillPassword("source-password"); await submit();
  await click("Confirm import");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("without duplicates");
  expect(host.textContent).toContain("Retry same import"); expect(changed).not.toHaveBeenCalled();
});

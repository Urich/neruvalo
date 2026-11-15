// @vitest-environment jsdom
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { empty, Entry } from "./model";
import { setPreference } from "./i18n";
const native = vi.hoisted(() => ({invoke:vi.fn(),listen:vi.fn()}));
vi.mock("@tauri-apps/api/core", () => ({invoke:native.invoke}));
vi.mock("@tauri-apps/api/event", () => ({listen:native.listen}));
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let root: Root, host: HTMLDivElement;
const records: Entry[] = Array.from({length:120},(_,i) => ({record_id:String(i),version_id:`v${i}`,revision:1,archived:false,data:{...empty(),title:`Entry ${String(i).padStart(3,"0")}`,fields:{password:`secret-${i}`}}}));
let finish: (() => void) | undefined;
beforeEach(() => {
  setPreference("en"); finish = undefined;
  native.invoke.mockReset(); native.listen.mockReset().mockResolvedValue(() => {});
  native.invoke.mockImplementation(async (_,{request}) => {
    if (request.action === "status") return {unlocked:true,online:true,profile:"test-profile"};
    if (request.action === "profiles" || request.action === "groups") return [];
    if (request.action === "sharing") return {incoming:[],outgoing:[]};
    if (request.action === "list") return records.map(record => ({...record,summary:true,data:{...record.data,fields:{password:"••••"}}}));
    if (request.action === "list_records") return records.filter(record => request.ids.includes(record.record_id)).map(record => request.list_view ? {...record,summary:true,row_loaded:true,data:{...record.data,fields:{password:"••••"}}} : record);
    return null;
  });
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async () => {await act(async () => root.unmount());host.remove();});
async function mount() {await act(async () => root.render(<App />));}
it("loads the first page on startup and another page on scroll", async () => {
  await mount();
  expect(host.querySelectorAll(".record")).toHaveLength(50);
  expect(native.invoke.mock.calls.filter(([,args]) => args.request.action === "list_records")).toHaveLength(1);
  const tree=host.querySelector<HTMLElement>('[role="tree"]')!;
  await act(async () => tree.dispatchEvent(new Event("scroll",{bubbles:true})));
  expect(host.querySelectorAll(".record")).toHaveLength(100);
  const batches=native.invoke.mock.calls.filter(([,args]) => args.request.action === "list_records");
  expect(batches).toHaveLength(2);
  expect(batches.every(([,args]) => args.request.ids.length <= 50 && args.request.expected_profile === "test-profile")).toBe(true);
});
it("searches the full index and fetches a matching entry beyond the loaded page", async () => {
  await mount();
  const input=host.querySelector<HTMLInputElement>('.search input')!;
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"Entry 119");input.dispatchEvent(new Event("input",{bubbles:true}));});
  expect(host.querySelectorAll(".record")).toHaveLength(1);
  expect(host.querySelector(".record")!.textContent).toContain("Entry 119");
  expect(native.invoke).toHaveBeenCalledWith("command",{request:{action:"list_records",ids:["119"],list_view:true,expected_profile:"test-profile"}});
});
it("shows the loading indicator until the record payloads arrive", async () => {
  const implementation=native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation((command,args) => args.request.action === "list_records" ? new Promise(resolve => {finish=() => resolve(records.slice(0,50));}) : implementation(command,args));
  await mount();
  expect(host.querySelector('[role="tree"]')!.getAttribute("aria-busy")).toBe("true");
  expect(host.textContent).toContain("Loading entries");
  await act(async () => finish!());
  expect(host.querySelector('[role="tree"]')!.getAttribute("aria-busy")).toBe("false");
});
it("retries a failed payload request without losing the index", async () => {
  const implementation=native.invoke.getMockImplementation()!;
  let failed=false;
  native.invoke.mockImplementation((command,args) => {
    if(args.request.action === "list_records" && !failed) {failed=true;return Promise.reject(Error("test load failure"));}
    return implementation(command,args);
  });
  await mount();
  expect(host.querySelectorAll(".record")).toHaveLength(50);
  const retry=[...host.querySelectorAll("button")].find(button => button.textContent === "Retry loading entries")!;
  expect(retry).toBeDefined();
  await act(async () => retry.click());
  expect(host.textContent).not.toContain("Retry loading entries");
  expect(host.querySelectorAll(".record")).toHaveLength(50);
});
it("fetches real contents before entering the editor from an unloaded row", async () => {
  const implementation=native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation((command,args) => args.request.action === "list_records" && args.request.ids.length > 1 ? new Promise(resolve => {finish=() => resolve(records.slice(0,50));}) : implementation(command,args));
  await mount();
  await act(async () => (host.querySelector(".record") as HTMLElement).click());
  const edit=[...host.querySelectorAll("button")].find(button => button.textContent === "Edit")!;
  await act(async () => edit.click());
  expect(host.querySelector<HTMLInputElement>('.password-generator-field input')!.value).toBe("secret-0");
  await act(async () => finish!());
});
it("adds a saved entry without reloading the index or existing payloads",async()=>{
  const implementation=native.invoke.getMockImplementation()!;
  const created={record_id:"created",version_id:"new-version",revision:1,archived:false,data:{...empty(),title:"ZZ new entry",group_id:null}};
  native.invoke.mockImplementation((command,args)=>args.request.action==="save" ? Promise.resolve({record_id:"created",group_id:null,record:created}) : implementation(command,args));
  await mount();
  const indexCalls=native.invoke.mock.calls.filter(([,args])=>args.request.action==="list").length;
  const payloadCalls=native.invoke.mock.calls.filter(([,args])=>args.request.action==="list_records").length;
  await act(async()=>[...host.querySelectorAll("button")].find(button=>button.textContent==="＋ Add entry")!.click());
  const title=host.querySelector<HTMLInputElement>(".detail-panel input")!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(title,"ZZ new entry");title.dispatchEvent(new Event("input",{bubbles:true}));});
  await act(async()=>[...host.querySelectorAll("button")].find(button=>button.textContent==="Encrypt and save")!.click());
  expect(host.querySelector('[data-record-id="created"] .record')!.textContent).toContain("ZZ new entry");
  expect(host.querySelector(".tree-row.selected .record")!.textContent).toContain("ZZ new entry");
  expect(host.querySelector(".detail-panel h2")!.textContent).toContain("ZZ new entry");
  expect(host.textContent).not.toContain("Loading entries");
  expect(native.invoke.mock.calls.filter(([,args])=>args.request.action==="list")).toHaveLength(indexCalls);
  expect(native.invoke.mock.calls.filter(([,args])=>args.request.action==="list_records")).toHaveLength(payloadCalls);
});


it.each(["UNSUPPORTED_LOCAL_SCHEMA", "UNSUPPORTED_VAULT_FORMAT", "UNSUPPORTED_PROTOCOL", "UNSUPPORTED_FORMAT"])("rejects an incompatible vault before showing records: %s", async error => {
  const implementation=native.invoke.getMockImplementation()!;
  let locked=false;
  native.invoke.mockImplementation((command,args) => {
    if(args.request.action === "lock") { locked=true; return Promise.resolve(null); }
    if(args.request.action === "status" && locked) return Promise.resolve({unlocked:false});
    if(args.request.action === "list") return Promise.reject(new Error(error));
    return implementation(command,args);
  });
  await mount();
  expect(locked).toBe(true);
  expect(host.querySelectorAll(".record")).toHaveLength(0);
  expect(host.querySelector(".auth-card h2")?.textContent).toBe("Unlock vault");
  expect(host.querySelector(".sidebar .nav.active")?.textContent?.trim()).toBe("Unlock vault");
  expect(host.textContent).toContain("This vault uses an unsupported database or data format");
  expect(host.textContent).not.toContain(error);
});

it("returns from an open vault to unlocking when synchronization finds a new format", async () => {
  const implementation=native.invoke.getMockImplementation()!;
  let locked=false;
  native.invoke.mockImplementation((command,args) => {
    if(args.request.action === "lock") { locked=true; return Promise.resolve(null); }
    if(args.request.action === "status" && locked) return Promise.resolve({unlocked:false});
    if(args.request.action === "sync") return Promise.reject(new Error("UNSUPPORTED_VAULT_FORMAT"));
    return implementation(command,args);
  });
  await mount();
  expect(host.querySelectorAll(".record")).toHaveLength(50);
  const sync=[...host.querySelectorAll("button")].find(button => button.textContent?.includes("Synchronize"))!;
  expect(sync).toBeTruthy();
  await act(async()=>sync.click());
  expect(locked).toBe(true);
  expect(host.querySelector(".auth-card h2")?.textContent).toBe("Unlock vault");
  expect(host.querySelectorAll(".record")).toHaveLength(0);
  expect(host.textContent).toContain("This vault uses an unsupported database or data format");
});

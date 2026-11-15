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
  setPreference("en"); native.invoke.mockReset().mockImplementation(async (_,{request}) => request.action === "local_file_info"
    ? {path:request.path.startsWith("/") ? request.path : `/vaults/${request.path}`,exists:request.path.startsWith("/existing")}
    : {local:true});
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
  const create=native.invoke.mock.calls.find(([,args])=>args.request.action === "create_local_file");
  expect(create?.[1].request).toMatchObject({path:"Personal",password:"local-password-123",confirmation:"local-password-123"});
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


it("closes restoration when the app rejects an incompatible vault format", async () => {
  const reject = vi.fn().mockResolvedValue(true);
  await act(async () => root.render(<LocalVaultTools status={{unlocked:false}} profiles={[]} source=""
    onSource={source} onChanged={changed} onConnect={connect} onUnsupportedVault={reject} />));
  await click("Restore from backup");
  await fill(host.querySelector<HTMLInputElement>('dialog input[type="password"]')!, "local-password-123");
  const error = new Error("UNSUPPORTED_VAULT_FORMAT");
  native.invoke.mockRejectedValueOnce(error);
  await act(async () => host.querySelector<HTMLButtonElement>('[type="submit"]')!.click());
  expect(reject).toHaveBeenCalledWith(error);
  expect(host.querySelector("dialog")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it("opens an existing file from the creation form using its password", async () => {
  await mount(); await click("Create local vault");
  const chosen={id:"choice-1",name:"cache.sqlite3",path:"/existing/vault/cache.sqlite3"};
  native.invoke.mockResolvedValueOnce(chosen.path);
  await click("Choose file…");
  expect(native.invoke.mock.calls[0][1].request.action).toBe("local_pick_target");
  expect(host.querySelector("dialog h2")?.textContent).toBe("Local vault");
  expect(host.querySelector<HTMLInputElement>('dialog input[placeholder="vault.nvdb"]')!.value).toBe(chosen.path);
  expect(host.querySelectorAll('dialog input[type="password"]')).toHaveLength(1);
  expect(host.querySelector<HTMLButtonElement>('dialog [type="submit"]')!.disabled).toBe(true);
  await fill(host.querySelector<HTMLInputElement>('dialog input[type="password"]')!,"existing-password");
  await act(async()=>host.querySelector<HTMLButtonElement>('dialog [type="submit"]')!.click());
  expect(native.invoke.mock.calls.find(([,args])=>args.request.action === "open_local_path")?.[1].request).toMatchObject({path:chosen.path,password:"existing-password"});
  expect(native.invoke.mock.calls.some(([,args])=>args.request.action==="create_local")).toBe(false);
  expect(changed).toHaveBeenCalledOnce();
});

it("keeps the creation form intact when file selection is cancelled", async () => {
  await mount();await click("Create local vault");
  await fill(host.querySelector<HTMLInputElement>("dialog input")!,"My draft");
  native.invoke.mockResolvedValueOnce(null);
  await click("Choose file…");
  expect(host.querySelector("dialog h2")?.textContent).toBe("Local vault");
  expect(host.querySelector<HTMLInputElement>("dialog input")!.value).toBe("My draft");
  expect(changed).not.toHaveBeenCalled();
});

it("keeps an existing selection retryable after a wrong password", async () => {
  await mount();await click("Create local vault");
  native.invoke.mockResolvedValueOnce("/existing/profile.json");
  await click("Choose file…");
  await fill(host.querySelector<HTMLInputElement>('dialog input[type="password"]')!,"wrong-password");
  native.invoke.mockRejectedValueOnce(new Error("incorrect secret or damaged data"));
  await act(async()=>host.querySelector<HTMLButtonElement>('dialog [type="submit"]')!.click());
  expect(host.querySelector("dialog")?.open).toBe(true);
  expect(host.querySelector('[role="alert"]')!.textContent).toBe(translate("ui.incorrectPasswordOrDamagedData"));
  await fill(host.querySelector<HTMLInputElement>('dialog input[type="password"]')!,"correct-password");
  await act(async()=>host.querySelector<HTMLButtonElement>('dialog [type="submit"]')!.click());
  expect(native.invoke.mock.calls.at(-1)![1].request.path).toBe("/existing/profile.json");
  expect(changed).toHaveBeenCalledOnce();
});

it("switches between opening and creating after choosing a filename",async()=>{
  await mount();await click("Create local vault");
  const input=host.querySelector<HTMLInputElement>('dialog input[placeholder="vault.nvdb"]')!;
  await fill(input,"/existing/personal.nvdb");
  expect(host.textContent).toContain("This file exists");
  expect(host.querySelectorAll('dialog input[type="password"]')).toHaveLength(1);
  await fill(input,"personal.nvdb");
  native.invoke.mockResolvedValueOnce("/chosen/personal.nvdb");
  await click("Choose file…");
  expect(input.value).toBe("/chosen/personal.nvdb");
  expect(host.textContent).toContain("A new vault will be created here");
  expect(host.querySelectorAll('dialog input[type="password"]')).toHaveLength(2);
});

it("ignores an older filename check that resolves after the path changes",async()=>{
  const original=native.invoke.getMockImplementation()!;
  let finish: (value:unknown)=>void = ()=>{};
  native.invoke.mockImplementation((...args)=>args[1].request.action==="local_file_info" && args[1].request.path==="old.nvdb"
    ? new Promise(resolve=>{finish=resolve;}) : original(...args));
  await mount();await click("Create local vault");
  const input=host.querySelector<HTMLInputElement>('dialog input[placeholder="vault.nvdb"]')!;
  await fill(input,"old.nvdb");
  expect(host.querySelector<HTMLButtonElement>('dialog [type="submit"]')!.disabled).toBe(true);
  await fill(input,"new.nvdb");
  await act(async()=>finish({path:"/old.nvdb",exists:true}));
  expect(host.textContent).toContain("/vaults/new.nvdb");
  expect(host.textContent).not.toContain("This file exists");
  expect(host.querySelectorAll('dialog input[type="password"]')).toHaveLength(2);
});


it("does not overwrite or automatically open a file that appeared after checking",async()=>{
  const original=native.invoke.getMockImplementation()!;
  let appeared=false;
  native.invoke.mockImplementation((...args)=>{
    const r=args[1].request;
    if(r.action==="create_local_file") {appeared=true;return Promise.reject(new Error("LOCAL_VAULT_FILE_EXISTS"));}
    if(r.action==="local_file_info") return Promise.resolve({path:"/vaults/race.nvdb",exists:appeared});
    return original(...args);
  });
  await mount();await click("Create local vault");
  await fill(host.querySelector<HTMLInputElement>('dialog input[placeholder="vault.nvdb"]')!,"race.nvdb");
  const passwords=host.querySelectorAll<HTMLInputElement>('dialog input[type="password"]');
  await fill(passwords[0],"creation-password");await fill(passwords[1],"creation-password");
  await act(async()=>host.querySelector<HTMLButtonElement>('dialog [type="submit"]')!.click());
  expect(host.textContent).toContain("This file already exists");
  expect(host.querySelectorAll('dialog input[type="password"]')).toHaveLength(1);
  expect(host.querySelector<HTMLInputElement>('dialog input[type="password"]')!.value).toBe("");
  expect(native.invoke.mock.calls.some(([,args])=>args.request.action==="open_local_path")).toBe(false);
  expect(changed).not.toHaveBeenCalled();
});


it("offers to open an existing file selected next to the filename without creating it",async()=>{
  await mount();await click("Create local vault");
  native.invoke.mockResolvedValueOnce("/existing/work.nvdb");
  await click("Choose file…");
  expect(native.invoke.mock.calls[0][1].request.action).toBe("local_pick_target");
  expect(host.querySelector<HTMLInputElement>('dialog input[placeholder="vault.nvdb"]')!.value).toBe("/existing/work.nvdb");
  expect(host.textContent).toContain("This file exists");
  expect(host.querySelector<HTMLButtonElement>('dialog [type="submit"]')!.textContent).toBe("Open");
  expect([...host.querySelectorAll("dialog button")].filter(button=>button.textContent?.trim() === "Open")).toHaveLength(1);
  expect(host.textContent).not.toContain("Open…");
  expect(host.querySelectorAll('dialog input[type="password"]')).toHaveLength(1);
  expect(changed).not.toHaveBeenCalled();
  expect(native.invoke.mock.calls.some(([,args])=>["create_local_file","open_local_path"].includes(args.request.action))).toBe(false);
});

it("keeps the typed filename when choosing a file is cancelled",async()=>{
  await mount();await click("Create local vault");
  const input=host.querySelector<HTMLInputElement>('dialog input[placeholder="vault.nvdb"]')!;
  await fill(input,"draft.nvdb");
  native.invoke.mockResolvedValueOnce(null);
  await click("Choose file…");
  expect(input.value).toBe("draft.nvdb");
  expect(host.textContent).toContain("A new vault will be created here");
});

it("chooses a not-yet-existing filename through New file and creates only after password confirmation",async()=>{
  await mount();await click("Create local vault");
  native.invoke.mockResolvedValueOnce("/chosen/new-vault.nvdb");
  await click("New file…");
  expect(native.invoke.mock.calls[0][1].request).toMatchObject({action:"local_pick_target",mode:"new"});
  expect(host.querySelector<HTMLInputElement>('dialog input[placeholder="vault.nvdb"]')!.value).toBe("/chosen/new-vault.nvdb");
  expect(host.textContent).toContain("A new vault will be created here");
  expect(host.querySelector<HTMLButtonElement>('dialog [type="submit"]')!.disabled).toBe(true);
  expect(changed).not.toHaveBeenCalled();
  const passwords=host.querySelectorAll<HTMLInputElement>('dialog input[type="password"]');
  await fill(passwords[0],"new-file-password");await fill(passwords[1],"new-file-password");
  await act(async()=>host.querySelector<HTMLButtonElement>('dialog [type="submit"]')!.click());
  expect(native.invoke.mock.calls.at(-1)![1].request).toMatchObject({action:"create_local_file",path:"/chosen/new-vault.nvdb"});
  expect(changed).toHaveBeenCalledOnce();
});

it("keeps the path after cancelling New file and uses open mode for existing vaults",async()=>{
  await mount();await click("Create local vault");
  const input=host.querySelector<HTMLInputElement>('dialog input[placeholder="vault.nvdb"]')!;
  await fill(input,"draft.nvdb");
  native.invoke.mockResolvedValueOnce(null);await click("New file…");
  expect(input.value).toBe("draft.nvdb");
  native.invoke.mockResolvedValueOnce("/existing/work.nvdb");await click("Choose file…");
  expect(native.invoke.mock.calls.filter(([,args])=>args.request.action==="local_pick_target").at(-1)?.[1].request.mode).toBe("existing");
  expect(host.querySelector<HTMLButtonElement>('dialog [type="submit"]')!.textContent).toBe("Open");
});

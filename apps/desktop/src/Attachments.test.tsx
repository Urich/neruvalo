// @vitest-environment jsdom
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Attachments } from "./Attachments";
import { setPreference } from "./i18n";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, host: HTMLDivElement;
const file = { id: "id", name: "secret.pdf", size: 3, data: "SECRET-BYTES" };
const changed = vi.fn();
beforeEach(() => {
  setPreference("en"); native.invoke.mockReset(); changed.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function click(text: string) {
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === text)!.click());
}
it("saves through a profile-bound native dialog without displaying file contents", async () => {
  await act(async () => root.render(<Attachments items={[file]} profile="alice" />));
  expect(host.textContent).toContain(file.name);
  expect(host.innerHTML).not.toContain(file.data);
  expect(host.textContent).not.toContain("Remove");
  await click("Save as…");
  expect(native.invoke).toHaveBeenCalledWith("command", { request: { action: "save_attachment", expected_profile: "alice", attachment: file } });
});
it("stages additions and removals and handles cancelled file selection", async () => {
  await act(async () => root.render(<Attachments items={[file]} profile="alice" onChange={changed} />));
  await click("Remove"); expect(changed).toHaveBeenCalledWith([]);
  changed.mockClear(); native.invoke.mockResolvedValue(null);
  await click("Add file"); expect(changed).not.toHaveBeenCalled();
  const next = { ...file, id: "next" }; native.invoke.mockResolvedValue(next);
  await click("Add file"); expect(changed).toHaveBeenCalledWith([file, next]);
});
it("rejects exceeding the total limit before updating the draft", async () => {
  const files = Array.from({ length: 4 }, (_, i) => ({ ...file, id: String(i), size: 1024 * 1024 }));
  await act(async () => root.render(<Attachments items={files} profile="alice" onChange={changed} />));
  native.invoke.mockResolvedValue(file); await click("Add file");
  expect(changed).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("4 MiB");
});

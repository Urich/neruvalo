// @vitest-environment jsdom
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { empty } from "./model";
import { setPreference } from "./i18n";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlocked: false,
  lockListener: undefined as undefined | (() => void),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

let root: Root | undefined;
let host: HTMLDivElement | undefined;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// jsdom does not implement native dialogs. These shims cover open/close state;
// the browser's focus trap and rendering require a native UI smoke check.
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  },
  close: {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  },
});

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(node: HTMLElement) {
  await act(async () => {
    node.focus();
    node.click();
  });
}
async function setTitle(value: string) {
  const input = document.querySelector<HTMLInputElement>(
    ".detail-panel input",
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function title() {
  return document.querySelector<HTMLInputElement>(".detail-panel input")?.value;
}

beforeEach(async () => {
  setPreference("ru");
  root = undefined;
  host = undefined;
  native.unlocked = false;
  native.lockListener = undefined;
  native.invoke.mockReset();
  native.listen.mockReset();
  native.invoke.mockImplementation(async (_command, { request }) => {
    switch (request.action) {
      case "profiles":
        return [];
      case "login":
        native.unlocked = true;
        return null;
      case "status":
        return { unlocked: native.unlocked, online: true, login: "alice" };
      case "list":
        return [
          {
            record_id: "record-id",
            version_id: "version-id",
            revision: 3,
            archived: false,
            data: { ...empty(), title: "Saved record" },
          },
        ];
      default:
        return null;
    }
  });
  native.listen.mockImplementation(async (_name, listener) => {
    native.lockListener = listener;
    return () => {
      native.lockListener = undefined;
    };
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<App />);
  });
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
});
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  vi.restoreAllMocks();
});

describe("adding a record while a draft is open", () => {
  it("opens the first form directly and asks before replacing even an empty draft", async () => {
    await click(button("＋ Добавить запись"));
    expect(document.querySelector("dialog")).toBeNull();
    await click(button("＋ Добавить запись"));
    expect(document.querySelector("dialog")?.open).toBe(true);
  });
  it("keeps unsaved input when the user continues editing or presses Escape", async () => {
    await click(button("＋ Добавить запись"));
    await setTitle("Unsaved title");
    await click(button("＋ Добавить запись"));
    await click(button("Продолжить редактирование"));
    expect(title()).toBe("Unsaved title");
    await click(button("＋ Добавить запись"));
    await act(async () => {
      document
        .querySelector("dialog")!
        .dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(document.querySelector("dialog")).toBeNull();
    expect(title()).toBe("Unsaved title");
  });
  it("starts an empty draft only after confirmation and does not save the discarded data", async () => {
    await click(button("＋ Добавить запись"));
    await setTitle("Discarded title");
    await click(button("＋ Добавить запись"));
    await click(button("Начать новую запись"));
    expect(document.querySelector("dialog")).toBeNull();
    expect(title()).toBe("");
    expect(
      native.invoke.mock.calls.some(
        ([, args]) => args.request.action === "save",
      ),
    ).toBe(false);
  });
  it("preserves the record identity and revision when cancelling from an edit form", async () => {
    await click(document.querySelector<HTMLElement>(".record")!);
    await click(button("Редактировать"));
    await setTitle("Edited title");
    await click(button("＋ Добавить запись"));
    await click(button("Продолжить редактирование"));
    await click(button("Зашифровать и сохранить"));
    const save = native.invoke.mock.calls.find(
      ([, args]) => args.request.action === "save",
    );
    expect(save?.[1].request).toMatchObject({
      id: "record-id",
      expected_revision: 3,
      data: { title: "Edited title" },
    });
  });
  it("clears the confirmation and draft when the vault locks", async () => {
    await click(button("＋ Добавить запись"));
    await setTitle("Private draft");
    await click(button("＋ Добавить запись"));
    await act(async () => {
      native.unlocked = false;
      native.lockListener!();
    });
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.querySelector(".detail-panel")).toBeNull();
    expect(document.body.textContent).not.toContain("Private draft");
  });
});

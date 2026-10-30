// @vitest-environment jsdom
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import App from "./App";
import { Group } from "./groups";
import { empty, Entry } from "./model";
import { setPreference } from "./i18n";
const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlocked: false,
  online: true,
  pinned: "",
  servers: ["https://a.example", "https://b.example"],
  groups: [] as Group[],
  records: [] as Entry[],
  incoming: [] as Entry[],
  outgoing: [] as any[],
  activeServer: "https://a.example",
  lock: undefined as (() => void) | undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
let root: Root, host: HTMLDivElement;
const entries: Entry[] = ["One", "Two"].map((title, i) => ({
  record_id: title,
  version_id: title,
  revision: 1,
  archived: false,
  data: {
    ...empty(),
    title,
    folder: i ? "Banks/A" : "",
    fields: { login: title + " user", password: title + " secret" },
  },
}));
function button(label: string, scope: ParentNode = document) {
  const node = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) =>
      b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );
  if (!node) throw Error("Missing button " + label);
  return node;
}
async function click(node: HTMLElement) {
  await act(async () => {
    node.focus();
    node.click();
  });
}
async function change(
  node: HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      node instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(node, value);
    node.dispatchEvent(
      new Event(node instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<App />));
}
async function login() {
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
function copies() {
  return native.invoke.mock.calls
    .filter(([, args]) => args.request.action === "copy_field")
    .map(([, args]) => args.request);
}
beforeEach(() => {
  localStorage.clear();
  setPreference("ru");
  native.unlocked = false;
  native.online = true;
  native.pinned = "";
  native.servers = ["https://a.example", "https://b.example"];
  native.records = structuredClone(entries);
  native.groups = [];
  native.incoming = [];
  native.outgoing = [];
  native.activeServer = "https://a.example";
  native.invoke.mockReset();
  native.listen.mockReset();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  native.invoke.mockImplementation(async (_, { request: r }) => {
    switch (r.action) {
      case "launch_config":
        return {
          pinned_server: native.pinned || null,
          startup_error: null,
          servers: native.servers,
          locale: "ru-RU",
        };
      case "profiles":
        return [
          { id: "a", server: "https://a.example", login: "alice" },
          { id: "b", server: "https://b.example", login: "bob" },
        ];
      case "status":
        return {
          unlocked: native.unlocked,
          online: native.online,
          login: "alice",
          server: native.activeServer,
          timeout_seconds: 60,
        };
      case "list":
        return native.records;
      case "sharing":
        return { incoming: native.incoming, outgoing: native.outgoing };
      case "resolve_recipient":
        return {
          id: "bob-id",
          login: r.login,
          public_sign: "sign-key",
          public_share: "share-key",
          fingerprint: "verified-fingerprint",
        };
      case "share_change": {
        if (r.kind === "create")
          native.outgoing.push({
            record_id: r.id,
            recipient_login: r.target,
            share_id: "grant-1",
          });
        else if (r.kind === "revoke") native.outgoing = [];
        else native.incoming = [];
        return { changed: true };
      }
      case "groups":
        return native.groups;
      case "create_group": {
        const id =
          "00000000-0000-4000-8000-" +
          String(native.groups.length + 1).padStart(12, "0");
        native.groups.push({ id, title: r.title, parent_id: r.parent });
        return { record_id: id };
      }
      case "save": {
        const id = r.id ?? "created-record";
        const value = {
          record_id: id,
          version_id: "new",
          revision: (r.expected_revision ?? 0) + 1,
          archived: !!r.archived,
          data: {
            ...r.data,
            ...(Object.hasOwn(r, "group") ? { group_id: r.group } : {}),
          },
        };
        native.records = [
          ...native.records.filter((e) => e.record_id !== id),
          value,
        ];
        return { record_id: id, group_id: r.group ?? null };
      }
      case "login":
      case "unlock_offline":
        native.activeServer =
          r.action === "login"
            ? r.server
            : native.pinned ||
              (r.id === "b" ? "https://b.example" : "https://a.example");
        native.unlocked = true;
        return null;
      case "history":
        return [entries.find((e) => e.record_id === r.id)];
      default:
        return null;
    }
  });
  native.listen.mockImplementation(async (_, listener) => {
    native.lock = listener;
    return () => {};
  });
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.restoreAllMocks();
});
describe("login and local server history", () => {
  it("hides vault navigation until sign-in and uses the recent server without contacting it", async () => {
    await mount();
    expect(document.querySelector(".nav-label")).toBeNull();
    expect(document.body.textContent).not.toContain("Мастер-пароль");
    const server = [...document.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === "https://a.example"),
    )!;
    expect(server.value).toBe("https://a.example");
    expect(
      native.invoke.mock.calls.some(([, a]) => a.request.action === "login"),
    ).toBe(false);
    await login();
    expect(document.querySelector(".nav-label")).toBeNull();
    expect(
      [...document.querySelectorAll(".sidebar button")].some((b) =>
        b.textContent?.includes("Все записи"),
      ),
    ).toBe(true);
    expect(document.querySelector(".account-identity")?.textContent).toContain(
      "alicehttps://a.example",
    );
    expect(document.body.textContent).not.toContain("Ваше хранилище");
    expect(document.body.textContent).not.toContain(
      "Тихое место для важных вещей.",
    );
    expect(document.body.textContent).not.toContain("ЛИЧНОЕ");
    await click(button("Заблокировать"));
    expect(document.querySelector(".nav-label")).toBeNull();
  });
  it("hides the server selector for --server and limits saved profiles to that origin", async () => {
    native.pinned = "https://b.example";
    await mount();
    expect(
      document.querySelector("input[readonly]")?.getAttribute("value"),
    ).toBe("https://b.example");
    expect(
      [...document.querySelectorAll("option")].some((o) =>
        o.textContent?.includes("Другой сервер"),
      ),
    ).toBe(false);
    expect(
      [...document.querySelectorAll("option")].some((o) => o.value === "a"),
    ).toBe(false);
    await login();
    expect(
      native.invoke.mock.calls.find(
        ([, a]) => a.request.action === "login",
      )?.[1].request.server,
    ).toBe("https://b.example");
  });
  it("offers address entry when there is no server history", async () => {
    native.servers = [];
    await mount();
    expect(document.querySelector('input[autocomplete="url"]')).not.toBeNull();
  });
});
describe("settings, language and folders", () => {
  it("moves lock/clipboard controls into settings and changes language without losing a draft", async () => {
    await mount();
    await login();
    expect(document.body.textContent).not.toContain("Очистка буфера");
    await click(button("＋ Добавить запись"));
    await change(
      document.querySelector<HTMLInputElement>(".detail-panel input")!,
      "Never translate this secret",
    );
    await click(button("Настройки"));
    expect(document.body.textContent).toContain("Очистка буфера");
    const languages = [...document.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === "ar"),
    )!;
    await change(languages, "ar");
    expect(document.querySelector(".app")?.getAttribute("dir")).toBe("rtl");
    await click(button("الإعدادات"));
    expect(
      document.querySelector<HTMLInputElement>(".detail-panel input")?.value,
    ).toBe("Never translate this secret");
    expect(localStorage.getItem("neruvalo.language")).toContain("ar");
  });
  it("shows legacy folders in the main tree while filtering entries by type", async () => {
    await mount();
    await login();
    expect(document.querySelector(".sidebar [data-group-id]")).toBeNull();
    await click(button("Banks"));
    expect(document.querySelectorAll(".record")).toHaveLength(2);
    expect(
      document.querySelector('[role="tree"] [data-group-id="legacy:Banks/A"]'),
    ).not.toBeNull();
    await click(button("Заметка"));
    expect(document.querySelectorAll(".record")).toHaveLength(0);
    expect(document.querySelector('[data-group-id="legacy:Banks"]')).toBeNull();
  });
});
describe("universal document editor", () => {
  it("saves country, template, leading zeros, custom fields and a chosen tree group", async () => {
    await mount();
    await login();
    await click(button("Документы"));
    await click(button("＋ Добавить запись"));
    await change(
      document.querySelector<HTMLInputElement>(".detail-panel input")!,
      "International ID",
    );
    const input = (text: string) =>
      [...document.querySelectorAll<HTMLLabelElement>(".detail-panel label")]
        .find((l) => l.firstChild?.textContent === text)
        ?.querySelector<HTMLInputElement>("input");
    const select = (text: string) =>
      [...document.querySelectorAll<HTMLLabelElement>(".detail-panel label")]
        .find((l) => l.firstChild?.textContent === text)
        ?.querySelector<HTMLSelectElement>("select");
    await change(select("Шаблон документа")!, "passport");
    await change(input("Страна / организация")!, "Armenia");
    await change(input("Номер")!, "001234");
    await change(input("Дополнительное поле")!, "Local identifier");
    await click(button("Добавить поле"));
    await change(input("Local identifier")!, "0007");
    await change(select("Группа")!, "legacy:Banks/A");
    await click(button("Зашифровать и сохранить"));
    const saved = native.invoke.mock.calls.find(
      ([, a]) => a.request.action === "save",
    )?.[1].request.data;
    expect(saved).toMatchObject({
      record_type: "document",
      folder: "",
      fields: {
        template: "passport",
        country: "Armenia",
        number: "001234",
        "custom:Local identifier": "0007",
      },
    });
  });
});
describe("copy actions and draft protection", () => {
  it("copies the clicked row without selecting it or discarding an open draft", async () => {
    await mount();
    await login();
    await click(button("＋ Добавить запись"));
    await change(
      document.querySelector<HTMLInputElement>(".detail-panel input")!,
      "Unfinished",
    );
    await act(async () =>
      document.querySelector('[data-record-id="Two"] .record')!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 30,
          clientY: 50,
        }),
      ),
    );
    await click(
      button("Скопировать пароль", document.querySelector('[role="menu"]')!),
    );
    expect(copies()).toEqual([
      expect.objectContaining({ id: "Two", field: "password", seconds: 30 }),
    ]);
    expect(
      document.querySelector<HTMLInputElement>(".detail-panel input")?.value,
    ).toBe("Unfinished");
    expect(document.querySelector(".record.selected")).toBeNull();
  });
  it("clears menus on lock and denies copy keyboard commands while locked", async () => {
    await mount();
    await login();
    await click(document.querySelector<HTMLElement>(".record")!);
    await act(async () =>
      document
        .querySelector(".record")!
        .dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        ),
    );
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => {
      native.unlocked = false;
      native.lock!();
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "KeyP",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );
    expect(copies()).toHaveLength(0);
  });
  it("copies on physical keys offline, ignores repeats and text inputs", async () => {
    native.online = false;
    await mount();
    await login();
    await click(document.querySelector<HTMLElement>(".record")!);
    const key = (target: EventTarget, repeat = false) =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Г",
          code: "KeyU",
          ctrlKey: true,
          shiftKey: true,
          repeat,
          bubbles: true,
          cancelable: true,
        }),
      );
    await act(async () => {
      key(window);
    });
    expect(copies()).toHaveLength(1);
    await act(async () => {
      key(window, true);
    });
    expect(copies()).toHaveLength(1);
    await act(async () => {
      key(document.querySelector("input")!);
    });
    expect(copies()).toHaveLength(1);
  });
  it("asks before replacing a draft with another saved entry", async () => {
    await mount();
    await login();
    await click(button("＋ Добавить запись"));
    await change(
      document.querySelector<HTMLInputElement>(".detail-panel input")!,
      "Unfinished",
    );
    await click(document.querySelector<HTMLElement>(".record")!);
    expect(document.querySelector("dialog")?.textContent).toContain(
      "Отменить изменения?",
    );
    await click(button("Продолжить редактирование"));
    expect(
      document.querySelector<HTMLInputElement>(".detail-panel input")?.value,
    ).toBe("Unfinished");
  });
});

describe("nested groups in the main records list", () => {
  async function createGroup(title: string) {
    const input = document.querySelector<HTMLInputElement>(
      ".detail-panel input",
    )!;
    await change(input, title);
    await click(
      button("Создать группу", document.querySelector(".detail-panel")!),
    );
  }
  it("creates an empty group and subgroup, then a different entry type inside them", async () => {
    await mount();
    await login();
    await click(button("Заметка"));
    await click(button("Создать группу"));
    await createGroup("My bank");
    expect(native.groups[0]).toMatchObject({
      title: "My bank",
      parent_id: null,
    });
    expect(document.querySelector('[role="tree"]')?.textContent).toContain(
      "My bank",
    );
    await click(button("Создать подгруппу"));
    await createGroup("Cards");
    expect(native.groups[1].parent_id).toBe(native.groups[0].id);
    await click(
      button("Добавить запись", document.querySelector(".detail-panel")!),
    );
    await click(
      document.querySelector<HTMLButtonElement>(".type-dropdown > button")!,
    );
    await click(
      button("Банковская карта", document.querySelector(".type-dropdown")!),
    );
    await click(button("Продолжить"));
    await change(
      document.querySelector<HTMLInputElement>(".detail-panel input")!,
      "Card 001",
    );
    await click(button("Зашифровать и сохранить"));
    const saved = native.invoke.mock.calls.find(
      ([, a]) => a.request.action === "save",
    )?.[1].request;
    expect(saved).toMatchObject({
      group: native.groups[1].id,
      data: { record_type: "bank_card", title: "Card 001" },
    });
    const node = document.querySelector(
      `[data-group-id="${native.groups[1].id}"]`,
    )!;
    expect(
      node.querySelector('[data-record-id="created-record"]'),
    ).not.toBeNull();
    // A card created from the Note filter is revealed rather than apparently lost.
    expect(
      document.querySelector('[data-record-id="created-record"]'),
    ).not.toBeNull();
  });
  it("expands/collapses branches and retains ancestor context during search", async () => {
    await mount();
    await login();
    const root = document.querySelector<HTMLElement>(
      '[data-group-id="legacy:Banks"]',
    )!;
    await click(
      root.querySelector<HTMLElement>(":scope > .tree-row .tree-toggle")!,
    );
    expect(document.querySelector('[data-record-id="Two"]')).toBeNull();
    await change(
      document.querySelector<HTMLInputElement>(".search input")!,
      "Two",
    );
    expect(document.querySelector('[data-record-id="Two"]')).not.toBeNull();
    expect(
      document.querySelector('[data-group-id="legacy:Banks/A"]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-record-id="One"]')).toBeNull();
  });
  it("uses the right-clicked group as parent and protects an open entry draft", async () => {
    await mount();
    await login();
    await click(button("＋ Добавить запись"));
    await change(
      document.querySelector<HTMLInputElement>(".detail-panel input")!,
      "Unsaved secret",
    );
    const row = document.querySelector('[data-group-id="legacy:Banks/A"]')!;
    await act(async () =>
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      ),
    );
    await click(
      button("Создать подгруппу", document.querySelector('[role="menu"]')!),
    );
    expect(document.querySelector("dialog")).not.toBeNull();
    await click(button("Продолжить редактирование"));
    expect(
      document.querySelector<HTMLInputElement>(".detail-panel input")?.value,
    ).toBe("Unsaved secret");
    expect(
      native.invoke.mock.calls.some(
        ([, a]) => a.request.action === "create_group",
      ),
    ).toBe(false);
  });
  it("shows offline groups but disables creation and clears the tree on lock", async () => {
    native.online = false;
    native.groups = [
      { id: "saved-empty", title: "Offline empty", parent_id: null },
    ];
    await mount();
    await login();
    expect(button("Создать группу").disabled).toBe(true);
    expect(button("Offline empty")).toBeDefined();
    await act(async () => {
      native.unlocked = false;
      native.lock!();
    });
    expect(document.querySelector('[role="tree"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Offline empty");
  });
  it("shows the unlocked offline profile server instead of the previous form address", async () => {
    await mount();
    const profile =
      document.querySelector<HTMLSelectElement>(".auth-card select")!;
    await change(profile, "b");
    await login();
    expect(document.querySelector(".account-identity")?.textContent).toContain(
      "https://b.example",
    );
  });
});

describe("stale status response after lock", () => {
  it("does not restore the former account identity or tree", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await login();
      let finish: ((value: unknown) => void) | undefined;
      const original = native.invoke.getMockImplementation()!;
      native.invoke.mockImplementation(async (command, args) =>
        args.request.action === "status"
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : original(command, args),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await act(async () => {
        native.unlocked = false;
        native.lock!();
      });
      await act(async () => {
        finish!({
          unlocked: true,
          online: true,
          login: "old-account",
          server: "https://old.example",
        });
      });
      expect(document.querySelector(".account-identity")).toBeNull();
      expect(document.querySelector('[role="tree"]')).toBeNull();
      expect(document.body.textContent).not.toContain("old-account");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("archive confirmation and About", () => {
  it("targets the right-clicked group and cancels without a write", async () => {
    await mount();
    await login();
    const row = document.querySelector<HTMLElement>(
      '[data-group-id="legacy:Banks"]',
    )!;
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    await click(button("В архив", document.querySelector('[role="menu"]')!));
    expect(document.querySelector("dialog")?.textContent).toContain("Banks");
    expect(document.querySelector("dialog")?.textContent).toContain(
      "Записи: 1",
    );
    await click(button("Отмена", document.querySelector("dialog")!));
    expect(
      native.invoke.mock.calls.some(
        ([, a]) => a.request.action === "archive_tree",
      ),
    ).toBe(false);
  });
  it("shows license and version before login without contacting the server", async () => {
    await mount();
    await click(button("О программе"));
    expect(document.querySelector(".about-panel")?.textContent).toContain(
      "0.3.0",
    );
    expect(document.querySelector(".about-panel")?.textContent).toContain(
      "GNU AFFERO GENERAL PUBLIC LICENSE",
    );
    expect(
      native.invoke.mock.calls.some(([, a]) =>
        ["login", "sync", "open_project_link"].includes(a.request.action),
      ),
    ).toBe(false);
  });
});

describe("return from public screens", () => {
  it("returns from Settings and About to sign in without losing entered credentials", async () => {
    await mount();
    await change(
      document.querySelector<HTMLInputElement>(
        'input[autocomplete="username"]',
      )!,
      "draft_user",
    );
    await change(
      document.querySelector<HTMLInputElement>('input[type="password"]')!,
      "unsent-password",
    );
    for (const page of ["Настройки", "О программе"]) {
      await click(button(page));
      expect(document.querySelector(".auth-card")).toBeNull();
      await click(button("Вернуться ко входу"));
      expect(
        document.querySelector<HTMLInputElement>(
          'input[autocomplete="username"]',
        )?.value,
      ).toBe("draft_user");
      expect(
        document.querySelector<HTMLInputElement>('input[type="password"]')
          ?.value,
      ).toBe("unsent-password");
    }
    expect(
      native.invoke.mock.calls.some(([, a]) => a.request.action === "login"),
    ).toBe(false);
  });
});

describe("password generation in the editor", () => {
  it("uses device settings and never sends the generated password until save", async () => {
    await mount();
    await login();
    await click(button("＋ Добавить запись"));
    await click(button("Настройки"));
    const settings = document.querySelector(".generator-settings")!;
    await change(settings.querySelector("select")!, "32");
    await click(button("Вернуться в хранилище"));
    await click(button("Сгенерировать пароль"));
    const password = [
      ...document.querySelectorAll<HTMLInputElement>(".detail-panel input"),
    ].find((i) => i.type === "password")!.value;
    expect(password).toHaveLength(32);
    expect(JSON.parse(localStorage.getItem("neruvalo.generator")!).length).toBe(
      32,
    );
    expect(localStorage.getItem("neruvalo.generator")).not.toContain(password);
    expect(
      native.invoke.mock.calls.some(([, a]) => a.request.action === "save"),
    ).toBe(false);
  });
});

describe("shared-copy interface", () => {
  it("requires recipient verification and confirmation, then filters outgoing originals", async () => {
    await mount();
    await login();
    const row = document.querySelector<HTMLElement>('[data-record-id="One"]')!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await click(button("Поделиться", document.querySelector('[role="menu"]')!));
    await change(
      document.querySelector<HTMLInputElement>(".share-dialog input")!,
      "bob",
    );
    expect(
      native.invoke.mock.calls.some(
        ([, a]) => a.request.action === "share_change",
      ),
    ).toBe(false);
    await click(button("Проверить получателя"));
    expect(document.querySelector(".share-dialog")?.textContent).toContain(
      "verified-fingerprint",
    );
    await click(button("Подтвердить передачу"));
    expect(
      native.invoke.mock.calls.some(
        ([, a]) =>
          a.request.action === "share_change" &&
          a.request.kind === "create" &&
          a.request.id === "One",
      ),
    ).toBe(true);
    await click(button("Закрыть"));
    await click(button("С общим доступом"));
    expect(document.querySelector('[data-record-id="One"]')).not.toBeNull();
    expect(document.querySelector('[data-record-id="Two"]')).toBeNull();
    expect(document.querySelector('[data-group-id="legacy:Banks"]')).toBeNull();
  });
  it("received copies expose no editing, history or resharing and can be dismissed", async () => {
    native.incoming = [
      {
        ...structuredClone(entries[0]),
        record_id: "copy",
        received: true,
        owner_login: "owner",
        share_id: "grant",
        source_record_id: "original",
      },
    ];
    await mount();
    await login();
    await click(button("Полученные"));
    const row = document.querySelector<HTMLElement>('[data-record-id="copy"]')!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.textContent).not.toContain("Редактировать");
    expect(menu.textContent).not.toContain("Поделиться");
    expect(menu.textContent).not.toContain("История");
    await click(button("Убрать у меня", menu));
    await click(button("Подтвердить", document.querySelector("dialog")!));
    expect(
      native.invoke.mock.calls.some(
        ([, a]) =>
          a.request.action === "share_change" &&
          a.request.kind === "dismiss" &&
          a.request.id === "original",
      ),
    ).toBe(true);
    expect(document.querySelector('[data-record-id="copy"]')).toBeNull();
  });
});

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { HistoryVersion } from "./HistoryVersion";
import { ConfirmNewEntry } from "./ConfirmNewEntry";
import { useI18n, setSystemLocale } from "./i18n";
import { Icon } from "./Icon";
import { ArchiveDialog } from "./ArchiveDialog";
import { About } from "./About";
import { TypePicker } from "./TypePicker";
import { generatePassword, normalizeGenerator } from "./passwordGenerator";
import { DismissShare } from "./DismissShare";
import { ShareDialog, Recipient } from "./ShareDialog";
import { Settings } from "./Settings";
import { ContextMenu, MenuItem } from "./ContextMenu";
import {
  Group,
  groupsFor,
  parentOf,
  groupLabel,
  entryTree,
  archiveSelection,
} from "./groups";
import { EntryTree } from "./EntryTree";
import { GroupEditor, GroupDraft } from "./GroupEditor";
import { fieldsOf, documentTemplates, templateLabels } from "./documents";
import {
  Shortcuts,
  readLocal,
  writeLocal,
  loadShortcuts,
  sameShortcut,
  fromEvent,
  shortcutText,
  isMobile,
} from "./preferences";
import { Data, Entry, Profile, types, empty, errorText } from "./model";
type Status = {
  unlocked: boolean;
  online?: boolean;
  login?: string;
  server?: string;
  profile?: string;
  timeout_seconds?: number;
};
export default function App() {
  async function call<T = any>(
    action: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    return invoke("command", {
      request: { action, expected_profile: status.profile, ...args },
    });
  }
  const { t, language } = useI18n();
  const [generator, setGenerator] = useState(() =>
    normalizeGenerator(readLocal("neruvalo.generator", null)),
  );
  const [page, setPage] = useState<"vault" | "settings" | "about">("vault");
  const [treeReveal, setTreeReveal] = useState(0);
  const [savedGroups, setSavedGroups] = useState<Group[]>([]);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [draftGroup, setDraftGroup] = useState<string | null>(null);
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null);
  const [customName, setCustomName] = useState("");
  const [launch, setLaunch] = useState<{
    pinned_server?: string;
    startup_error?: string;
    servers: string[];
  }>({ servers: [] });
  const [configured, setConfigured] = useState(false);
  const [otherServer, setOtherServer] = useState(false);
  const [shortcuts, setShortcuts] = useState<Shortcuts>(() => loadShortcuts());
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    epoch: number;
    action: () => void;
  } | null>(null);
  const [status, setStatus] = useState<Status>({ unlocked: false });
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [server, setServer] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<"login" | "register" | "verify">("login");
  const [offline, setOffline] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(true);
  const [ticket, setTicket] = useState("");
  const [certReady, setCertReady] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [shareView, setShareView] = useState<"own" | "outgoing" | "received">(
    "own",
  );
  const [received, setReceived] = useState<Entry[]>([]);
  const [outgoing, setOutgoing] = useState<any[]>([]);
  const [dismissTarget, setDismissTarget] = useState<Entry | null>(null);
  const [shareTarget, setShareTarget] = useState<Entry | null>(null);
  const [selected, setSelected] = useState<Entry>();
  const [draft, setDraft] = useState<Data>();
  const [pendingNew, setPendingNew] = useState<{
    kind: string;
    epoch: number;
  } | null>(null);
  const [history, setHistory] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [archive, setArchive] = useState(false);
  const [archiveRequest, setArchiveRequest] = useState<{
    id: string;
    title: string;
    archived: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [needsSync, setNeedsSync] = useState(false);
  const [timeout, setTimeoutSeconds] = useState(60);
  const [clipboardSeconds, setClipboardSeconds] = useState<number>(() =>
    readLocal("neruvalo.clipboardSeconds", 30),
  );
  const generation = useRef(0);
  const lastTouch = useRef(0);
  const wasUnlocked = useRef(false);
  const clear = () => {
    wasUnlocked.current = false;
    generation.current++;
    setStatus({ unlocked: false });
    setEntries([]);
    setReceived([]);
    setOutgoing([]);
    setShareTarget(null);
    setDismissTarget(null);
    setShareView("own");
    setSelected(undefined);
    setDraft(undefined);
    setPendingNew(null);
    setArchiveRequest(null);
    setPendingAction(null);
    setMenu(null);
    setPage("vault");
    setActiveGroup(null);
    setDraftGroup(null);
    setGroupDraft(null);
    setSavedGroups([]);
    setCustomName("");
    setQuery("");
    setKind("");
    setOffline("");
    setHistory([]);
    setPassword("");
    setRevealed({});
    setCode("");
    setCertReady(false);
  };
  async function run(task: () => Promise<void>) {
    const epoch = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (e) {
      if (epoch !== generation.current) return;
      setError(errorText(e));
      if (
        String(e).includes("RECORD_VERSION_MISMATCH") ||
        String(e).includes("SHARING_VERSION_MISMATCH") ||
        String(e).includes("SYNCHRONIZATION_REQUIRED")
      )
        setNeedsSync(true);
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const epoch = generation.current;
    const s = await call<Status>("status");
    if (epoch !== generation.current) return;
    if (!s.unlocked) {
      clear();
      return;
    }
    const [list, groups, sharing] = await Promise.all([
      call<Entry[]>("list", { expected_profile: s.profile }),
      call<Group[]>("groups", { expected_profile: s.profile }),
      call("sharing", { expected_profile: s.profile }),
    ]);
    if (epoch !== generation.current) return;
    wasUnlocked.current = true;
    setStatus(s);
    setTimeoutSeconds(s.timeout_seconds ?? 60);
    const owned = list.map((e) => ({
      ...e,
      share_count: (sharing?.outgoing ?? []).filter(
        (g: any) => g.record_id === e.record_id,
      ).length,
    }));
    setEntries(owned);
    setReceived((previous) => {
      const next = sharing?.incoming ?? [];
      if (
        next.some(
          (e: Entry) => !previous.some((old) => old.record_id === e.record_id),
        )
      )
        setNotice("Вам предоставлен доступ к новой записи.");
      return next;
    });
    setOutgoing(sharing?.outgoing ?? []);
    if (sharing?.notifications?.length)
      setNotice("Вам предоставлен доступ к новой записи.");
    setSelected((current) =>
      current?.received
        ? (sharing?.incoming ?? []).find(
            (e: Entry) => e.record_id === current.record_id,
          )
        : current
          ? owned.find((e) => e.record_id === current.record_id)
          : current,
    );
    setSavedGroups(groups ?? []);
  }
  useEffect(() => {
    call("launch_config")
      .then((config) => {
        if (!config) {
          setConfigured(true);
          return;
        }
        setLaunch(config);
        if (config.locale) setSystemLocale(config.locale);
        setServer(config.pinned_server ?? config.servers[0] ?? "");
        setOtherServer(!config.servers.length);
        if (config.startup_error) setError(config.startup_error);
        setConfigured(true);
      })
      .catch((e) => setError(errorText(e)));
    call<Profile[]>("profiles")
      .then(setProfiles)
      .catch((e) => setError(errorText(e)));
    const timer = setInterval(() => {
      const epoch = generation.current;
      call<Status>("status")
        .then((s) => {
          if (epoch !== generation.current) return;
          if (!s.unlocked) {
            if (wasUnlocked.current) clear();
          } else setStatus(s);
        })
        .catch(() => {});
    }, 1000);
    const unlisten = listen("vault-locked", () => clear());
    return () => {
      clearInterval(timer);
      void unlisten.then((fn) => fn());
    };
  }, []);
  useEffect(() => {
    if (!status.unlocked) return;
    const touch = () => {
      if (Date.now() - lastTouch.current > 2000) {
        lastTouch.current = Date.now();
        void call("touch").catch(() => {});
      }
    };
    window.addEventListener("keydown", touch);
    window.addEventListener("pointerdown", touch);
    window.addEventListener("pointermove", touch);
    return () => {
      window.removeEventListener("keydown", touch);
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("pointermove", touch);
    };
  }, [status.unlocked, status.profile]);
  function requestLeave(action: () => void) {
    setMenu(null);
    if (draft || groupDraft) {
      setPendingAction({ epoch: generation.current, action });
      return;
    }
    action();
  }
  async function copy(entry: Entry, field: string) {
    if (!status.unlocked || busy || !entry.data.fields[field]) return;
    const epoch = generation.current;
    await run(async () => {
      await call("copy_field", {
        id: entry.record_id,
        field,
        seconds: clipboardSeconds,
      });
      if (epoch === generation.current) setNotice("Скопировано.");
    });
  }
  const accessibleProfiles = profiles.filter(
    (p) => !launch.pinned_server || p.server === launch.pinned_server,
  );
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.repeat ||
        e.isComposing ||
        !document.hasFocus() ||
        !status.unlocked ||
        draft ||
        groupDraft ||
        busy ||
        menu ||
        pendingNew ||
        pendingAction ||
        page !== "vault" ||
        !selected ||
        isMobile()
      )
        return;
      if (
        e.target instanceof Element &&
        e.target.closest(
          "input,textarea,select,[contenteditable],[data-shortcut-capture],dialog",
        )
      )
        return;
      const key = fromEvent(e);
      for (const action of ["login", "password"] as const)
        if (sameShortcut(key, shortcuts[action])) {
          e.preventDefault();
          void copy(selected, action);
          break;
        }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    status.unlocked,
    draft,
    groupDraft,
    busy,
    menu,
    page,
    selected,
    shortcuts,
    clipboardSeconds,
    pendingNew,
    pendingAction,
  ]);
  function context(e: React.MouseEvent | React.KeyboardEvent) {
    e.preventDefault();
    const target = e.target as HTMLElement;
    const rect = target.getBoundingClientRect();
    const x = "clientX" in e ? e.clientX : rect.left,
      y = "clientY" in e ? e.clientY : rect.bottom;
    const epoch = generation.current;
    const safe = (action: () => void) => () => {
      if (epoch === generation.current) action();
    };
    let items: MenuItem[] = [];
    if (target.matches("input,textarea,[contenteditable]")) {
      const input = target as HTMLInputElement;
      const start = input.selectionStart,
        end = input.selectionEnd;
      const edit = (command: string) =>
        safe(() => {
          input.focus();
          if (start !== null && end !== null)
            input.setSelectionRange(start, end);
          document.execCommand(command);
        });
      items = [
        { label: t("Отменить"), action: edit("undo") },
        { label: t("Повторить"), action: edit("redo") },
        {
          label: t("Вырезать"),
          disabled: input.readOnly || start === end,
          action: edit("cut"),
        },
        {
          label: t("Копировать"),
          disabled: start === end,
          action: edit("copy"),
        },
        {
          label: t("Вставить"),
          disabled: input.readOnly,
          action: safe(() => {
            void run(async () => {
              const value = await call<string>("read_clipboard");
              if (epoch !== generation.current) return;
              input.focus();
              if (start !== null && end !== null)
                input.setSelectionRange(start, end);
              document.execCommand("insertText", false, value);
            });
          }),
        },
        {
          label: t("Выделить всё"),
          action: safe(() => {
            input.focus();
            input.select();
          }),
        },
      ];
    } else if (status.unlocked) {
      const groupRow = target.closest<HTMLElement>("[data-group-id]");
      const recordRow = target.closest<HTMLElement>("[data-record-id]");
      if (groupRow && !recordRow) {
        const group = groups.find((g) => g.id === groupRow.dataset.groupId);
        if (group) {
          items = [
            {
              label: t("Добавить запись"),
              disabled: busy || !status.online || needsSync || !!group.archived,
              action: safe(() =>
                requestLeave(() => beginNew(kind || "login", group.id)),
              ),
            },
            {
              label: t("Создать подгруппу"),
              disabled: busy || !status.online || needsSync || !!group.archived,
              action: safe(() => requestLeave(() => beginGroup(group.id))),
            },
            {
              label: t(archive ? "Вернуть из архива" : "В архив"),
              disabled: busy || !status.online || needsSync,
              action: safe(() =>
                requestLeave(() =>
                  setArchiveRequest({
                    id: group.id,
                    title: group.title,
                    archived: !archive,
                  }),
                ),
              ),
            },
          ];
        }
        if (items.length) setMenu({ x, y, items });
        return;
      }
      const row = recordRow;
      const entry = row
        ? [...entries, ...received].find(
            (e) => e.record_id === row.dataset.recordId,
          )
        : target.closest(".detail-panel") && !draft
          ? selected
          : undefined;
      if (entry) {
        const record = entry;
        const field =
          target.closest<HTMLElement>("[data-field]")?.dataset.field;
        const copyItem = (key: string, label: string): MenuItem => ({
          label: t(label),
          disabled: !record.data.fields[key],
          hint:
            !isMobile() && ["login", "password"].includes(key)
              ? shortcutText(shortcuts[key as "login" | "password"])
              : undefined,
          action: safe(() => {
            void copy(record, key);
          }),
        });
        if (fieldsOf(record.data).some((f) => f[0] === "login"))
          items.push(copyItem("login", t("Скопировать логин")));
        if (fieldsOf(record.data).some((f) => f[0] === "password"))
          items.push(copyItem("password", t("Скопировать пароль")));
        if (field) items.push(copyItem(field, t("Копировать поле")));
        if (record.received) {
          items.push(
            {
              label: t("Открыть"),
              action: safe(() => requestLeave(() => open(record))),
            },
            {
              label: t("Убрать у меня"),
              disabled: busy || !status.online || needsSync,
              action: safe(() => requestLeave(() => setDismissTarget(record))),
            },
          );
          setMenu({ x, y, items });
          return;
        }
        items.push({
          label: t("Поделиться"),
          disabled: busy || !status.online || needsSync || record.archived,
          action: safe(() => requestLeave(() => setShareTarget(record))),
        });
        items.push(
          {
            label: t("Открыть"),
            action: safe(() => requestLeave(() => open(record))),
          },
          {
            label: t("Редактировать"),
            disabled: busy || !status.online || needsSync || record.archived,
            action: safe(() =>
              requestLeave(() => {
                open(record);
                setDraft(structuredClone(record.data));
              }),
            ),
          },
          {
            label: t("История"),
            disabled: busy,
            action: safe(() =>
              requestLeave(() => {
                open(record);
                void loadHistory(record);
              }),
            ),
          },
          {
            label: t(record.archived ? t("Вернуть из архива") : t("В архив")),
            disabled: busy || !status.online || needsSync,
            action: safe(() =>
              requestLeave(() => {
                void setArchived(!record.archived, record);
              }),
            ),
          },
        );
      }
    }
    if (items.length) setMenu({ x, y, items });
    else setMenu(null);
  }
  async function loadHistory(entry: Entry) {
    const epoch = generation.current;
    await run(async () => {
      const values = await call<Entry[]>("history", { id: entry.record_id });
      if (epoch === generation.current) setHistory(values);
    });
  }
  function selectGroup(group: Group) {
    requestLeave(() => {
      setSelected(undefined);
      setDraft(undefined);
      setGroupDraft(null);
      setHistory([]);
      setRevealed({});
      setActiveGroup(group.id);
    });
  }
  function beginGroup(parent: string | null = activeGroup) {
    setShareView("own");
    if (groups.find((g) => g.id === parent)?.archived) parent = null;
    setSelected(undefined);
    setDraft(undefined);
    setHistory([]);
    setRevealed({});
    setGroupDraft({ title: "", parent });
  }
  async function saveGroup() {
    if (!groupDraft) return;
    const epoch = generation.current;
    await run(async () => {
      const result = await call("create_group", {
        title: groupDraft.title.trim(),
        parent: groupDraft.parent,
      });
      if (epoch !== generation.current) return;
      setGroupDraft(null);
      setActiveGroup(result.record_id);
      setKind("");
      setQuery("");
      await refresh();
      setTreeReveal((n) => n + 1);
    });
  }
  function open(entry: Entry) {
    setGroupDraft(null);
    const parent = parentOf(entry.data, groups);
    setActiveGroup(parent);
    setDraftGroup(parent);
    setCustomName("");
    setSelected(entry);
    setDraft(undefined);
    setHistory([]);
    setRevealed({});
  }
  function beginNew(recordType: string, parent: string | null = activeGroup) {
    setShareView("own");
    if (groups.find((g) => g.id === parent)?.archived) parent = null;
    setGroupDraft(null);
    setDraftGroup(parent);
    setActiveGroup(parent);
    setSelected(undefined);
    setHistory([]);
    setRevealed({});
    setCustomName("");
    setDraft(empty(recordType));
  }
  function requestNew() {
    if (draft || groupDraft) {
      setPendingNew({ kind: kind || "login", epoch: generation.current });
      return;
    }
    beginNew(kind || "login");
  }
  function confirmNew() {
    const pending = pendingNew;
    setPendingNew(null);
    if (
      !pending ||
      pending.epoch !== generation.current ||
      !status.unlocked ||
      !status.online ||
      busy
    )
      return;
    beginNew(pending.kind);
  }
  async function signIn() {
    await run(async () => {
      if (!configured || launch.startup_error)
        throw new Error("Проверьте параметры запуска");
      if (certReady) throw new Error("Сначала сохраните мастер-сертификат.");
      if (offline) await call("unlock_offline", { id: offline, password });
      else await call("login", { server, login, password });
      setPassword("");
      setNeedsSync(false);
      await refresh();
      setProfiles(await call("profiles"));
      const config = await call("launch_config");
      if (config) setLaunch(config);
    });
  }
  async function register() {
    await run(async () => {
      const r = await call("register_begin", {
        server,
        login,
        email,
        password,
        with_recovery: recovery,
      });
      setTicket(r.ticket);
      setPassword("");
      setMode("verify");
    });
  }
  async function finishRegistration() {
    await run(async () => {
      await call("register_finish", { server, code });
      setCertReady(recovery);
      setMode("login");
      setCode("");
      setNotice(
        recovery
          ? "Аккаунт создан. Сохраните мастер-сертификат перед входом. После закрытия приложения восстановить этот файл будет нельзя."
          : "Аккаунт создан. Теперь войдите.",
      );
    });
  }
  async function sync() {
    await run(async () => {
      await call("sync");
      setNeedsSync(false);
      setDraft(undefined);
      setSelected(undefined);
      setHistory([]);
      setGroupDraft(null);
      await refresh();
      setNotice("Все изменения загружены.");
    });
  }
  async function save() {
    if (!draft) return;
    await run(async () => {
      const result = await call("save", {
        id: selected?.record_id ?? null,
        expected_revision: selected?.revision ?? 0,
        data: draft,
        group: draftGroup,
        archived: selected?.archived ?? false,
      });
      setActiveGroup(result?.group_id ?? draftGroup);
      if (!selected) setArchive(false);
      if (kind && kind !== draft.record_type) setKind("");
      setQuery("");
      setDraft(undefined);
      setSelected(undefined);
      await refresh();
      setTreeReveal((n) => n + 1);
    });
  }
  async function setArchived(
    value: boolean,
    record: Entry | undefined = selected,
  ) {
    if (!record) return;
    requestLeave(() =>
      setArchiveRequest({
        id: record.record_id,
        title: record.data.title,
        archived: value,
      }),
    );
  }
  async function applyArchive() {
    if (!archiveRequest) return;
    const request = archiveRequest;
    const epoch = generation.current;
    setArchiveRequest(null);
    await run(async () => {
      await call("archive_tree", {
        id: request.id,
        archived: request.archived,
      });
      if (epoch !== generation.current) return;
      setSelected(undefined);
      setActiveGroup(null);
      setHistory([]);
      await refresh();
    });
  }

  const groups = groupsFor(entries, savedGroups);
  const tree = entryTree(
    shareView === "received" ? [] : groups,
    shareView === "received"
      ? received
      : entries.filter((e) => shareView !== "outgoing" || !!e.share_count),
    query,
    kind,
    shareView === "received" ? false : archive,
    shareView === "outgoing",
  );
  const visibleCount = (nodes: typeof tree): number =>
    nodes.reduce(
      (count, node) =>
        count + (node.entry ? 1 : 0) + visibleCount(node.children),
      0,
    );
  const selectedGroup =
    (shareView !== "received"
      ? groups.find((g) => g.id === activeGroup)
      : undefined) ??
    groups.find(
      (g) =>
        activeGroup?.startsWith("legacy:") &&
        g.legacy_path === activeGroup.slice(7),
    );
  const activeServer =
    status.server ??
    profiles.find((p) => p.id === status.profile)?.server ??
    "";
  const currentType = types[(draft ?? selected?.data)?.record_type ?? "login"];
  return (
    <div
      className="app"
      lang={language}
      dir={language === "ar" ? "rtl" : "ltr"}
      onContextMenu={context}
      onKeyDown={(e) => {
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
          context(e);
      }}
    >
      {archiveRequest && status.unlocked && (
        <ArchiveDialog
          request={archiveRequest}
          counts={archiveSelection(
            archiveRequest.id,
            groups,
            entries,
            archiveRequest.archived,
          )}
          onCancel={() => setArchiveRequest(null)}
          onConfirm={() => {
            void applyArchive();
          }}
        />
      )}
      {shareTarget && status.unlocked && (
        <ShareDialog
          title={shareTarget.data.title}
          wallet={shareTarget.data.record_type === "crypto_wallet"}
          recipients={outgoing.filter(
            (g) => g.record_id === shareTarget.record_id,
          )}
          disabled={busy || !status.online || needsSync}
          onClose={() => setShareTarget(null)}
          onResolve={(login) => call<Recipient>("resolve_recipient", { login })}
          onCreate={async (login) => {
            await call("share_change", {
              kind: "create",
              id: shareTarget.record_id,
              target: login,
            });
            await refresh();
          }}
          onRevoke={async (id) => {
            await call("share_change", {
              kind: "revoke",
              id: shareTarget.record_id,
              target: id,
            });
            await refresh();
          }}
        />
      )}
      {dismissTarget && status.unlocked && (
        <DismissShare
          title={dismissTarget.data.title}
          onCancel={() => setDismissTarget(null)}
          onConfirm={() => {
            const item = dismissTarget;
            setDismissTarget(null);
            void run(async () => {
              await call("share_change", {
                kind: "dismiss",
                id: item.source_record_id,
                target: item.share_id,
              });
              setSelected(undefined);
              await refresh();
            });
          }}
        />
      )}
      {menu && <ContextMenu {...menu} close={() => setMenu(null)} />}
      {status.unlocked && pendingAction && (
        <ConfirmNewEntry
          general
          onCancel={() => setPendingAction(null)}
          onConfirm={() => {
            const pending = pendingAction;
            setPendingAction(null);
            if (pending.epoch === generation.current && !busy) pending.action();
          }}
        />
      )}
      {status.unlocked && pendingNew && (
        <ConfirmNewEntry
          onCancel={() => setPendingNew(null)}
          onConfirm={confirmNew}
        />
      )}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">n</span>
          <div>
            Neruvalo<small>YOUR PRIVATE SPACE</small>
          </div>
        </div>
        {status.unlocked && (
          <>
            <button
              className={!archive && shareView === "own" ? "nav active" : "nav"}
              onClick={() => {
                requestLeave(() => {
                  setPage("vault");
                  setArchive(false);
                  setShareView("own");
                  setActiveGroup(null);
                  setGroupDraft(null);
                  setKind("");
                  setSelected(undefined);
                  setDraft(undefined);
                });
              }}
            >
              <Icon name="all" /> <span>{t("Все записи")}</span>
              <b>{entries.filter((e) => !e.archived).length}</b>
            </button>
            <button
              className={archive ? "nav active" : "nav"}
              onClick={() => {
                requestLeave(() => {
                  setPage("vault");
                  setArchive(true);
                  setShareView("own");
                  setGroupDraft(null);
                  setSelected(undefined);
                  setDraft(undefined);
                });
              }}
            >
              <Icon name="archive" /> <span>{t("Архив")}</span>
            </button>
            {(["outgoing", "received"] as const).map((view) => (
              <button
                key={view}
                aria-label={t(
                  view === "outgoing" ? "С общим доступом" : "Полученные",
                )}
                className={shareView === view ? "nav active" : "nav"}
                onClick={() =>
                  requestLeave(() => {
                    setShareView(view);
                    setArchive(false);
                    setPage("vault");
                    setSelected(undefined);
                    setActiveGroup(null);
                    setKind("");
                    setQuery("");
                    setGroupDraft(null);
                  })
                }
              >
                <Icon name="share" />
                <span>
                  {t(view === "outgoing" ? "С общим доступом" : "Полученные")}
                </span>
                <b>
                  {view === "received"
                    ? received.length
                    : entries.filter((e) => e.share_count).length}
                </b>
              </button>
            ))}
            <div className="nav-gap" />
            {Object.entries(types).map(([key]) => (
              <button
                key={key}
                className={kind === key ? "nav active" : "nav"}
                onClick={() => {
                  setPage("vault");
                  setKind(kind === key ? "" : key);
                  if (!draft && !groupDraft) {
                    setSelected(undefined);
                    setHistory([]);
                    setRevealed({});
                  }
                }}
              >
                <Icon name={key} />
                <span>
                  {t(key === "document" ? t("Документы") : types[key].label)}
                </span>
              </button>
            ))}
          </>
        )}
        <div className="sidebar-bottom">
          <button
            className={page === "settings" ? "nav active" : "nav"}
            onClick={() => setPage(page === "settings" ? "vault" : "settings")}
          >
            <Icon name="settings" />
            <span>{t("Настройки")}</span>
          </button>
          <button
            className={page === "about" ? "nav active" : "nav"}
            onClick={() => setPage(page === "about" ? "vault" : "about")}
          >
            <Icon name="info" />
            <span>{t("О программе")}</span>
          </button>
          <div className="sidebar-foot">
            <span className="shield">◇</span>
            <p>
              {t("Ваши секреты шифруются")}
              <br />
              {t("на вашем устройстве.")}
            </p>
            <small>{t("Только тестовые данные")}</small>
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            {t("Личное пространство")}
            <span>/</span> {archive ? t("Архив") : t("Хранилище")}
          </div>
          <div className="connection">
            <i className={status.online ? "online" : ""} />
            {status.unlocked
              ? status.online
                ? t("На связи")
                : t("Офлайн · только чтение")
              : t("Заблокировано")}
          </div>
          {status.unlocked && (
            <>
              <button
                className="subtle"
                disabled={busy}
                onClick={() =>
                  requestLeave(() => {
                    void sync();
                  })
                }
              >
                {t("↻ Синхронизировать")}
              </button>
              <button
                className="subtle"
                onClick={() => {
                  void call("lock");
                  clear();
                }}
              >
                {t("Заблокировать")}
              </button>
            </>
          )}
        </header>
        <div className="content">
          {page !== "vault" && (
            <button
              type="button"
              className="secondary page-back"
              onClick={() => setPage("vault")}
            >
              {t(
                status.unlocked
                  ? "Вернуться в хранилище"
                  : "Вернуться ко входу",
              )}
            </button>
          )}
          {error && (
            <div className="banner error" role="alert">
              {t(error)}
            </div>
          )}
          {notice && (
            <div className="banner notice" role="status">
              {t(notice)}
            </div>
          )}
          {page === "about" ? (
            <About />
          ) : page === "settings" ? (
            <Settings
              loadProxy={() => call("proxy_settings")}
              saveProxy={async (settings) => {
                await call("set_proxy", { settings });
              }}
              generator={generator}
              onGenerator={(value) => {
                setGenerator(value);
                writeLocal("neruvalo.generator", value);
              }}
              login={status.unlocked ? status.login : undefined}
              server={activeServer}
              online={status.online}
              busy={busy}
              timeout={timeout}
              clipboard={clipboardSeconds}
              onTimeout={(seconds) => {
                void run(async () => {
                  await call("settings", { seconds });
                  setTimeoutSeconds(seconds);
                });
              }}
              onClipboard={(seconds) => {
                setClipboardSeconds(seconds);
                writeLocal("neruvalo.clipboardSeconds", seconds);
              }}
              shortcuts={shortcuts}
              onShortcuts={(value) => {
                setShortcuts(value);
                writeLocal("neruvalo.shortcuts", value);
              }}
            />
          ) : !status.unlocked ? (
            <div className="auth-layout">
              <section className="intro">
                <div className="eyebrow">
                  {t("СЕКРЕТЫ ПОД ВАШИМ КОНТРОЛЕМ")}
                </div>
                <h1>
                  {t("Всё важное.")}
                  <br />
                  <em>{t("Только ваше.")}</em>
                </h1>
                <p>
                  {t("Пароли, карты, ключи и личные записи.")}
                  <br />
                  {t("Одно защищённое пространство на вашем сервере.")}
                </p>
                <div className="intro-line" />
                <div className="facts">
                  <span>{t("◎ Клиентское шифрование")}</span>
                  <span>{t("⌁ Открытый исходный код")}</span>
                  <span>{t("▤ Офлайн-просмотр")}</span>
                </div>
              </section>
              <section className="auth-card">
                <div className="card-symbol">◇</div>
                <h2>
                  {mode === "verify"
                    ? t("Подтвердите email")
                    : mode === "register"
                      ? t("Создать аккаунт")
                      : t("Открыть хранилище")}
                </h2>
                <p className="muted">
                  {mode === "verify"
                    ? t(
                        "В прототипе письмо записано в закрытый dev-outbox сервера.",
                      )
                    : t("Пароль остаётся на вашем устройстве.")}
                </p>
                {mode === "verify" ? (
                  <>
                    <label>
                      {t("Код из письма")}
                      <input
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    <p className="ticket">
                      {t("Файл письма:")}
                      {ticket}.txt
                    </p>
                    <button
                      className="primary full"
                      disabled={busy || !code}
                      onClick={finishRegistration}
                    >
                      {t("Подтвердить")}
                    </button>
                  </>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void (mode === "register" ? register() : signIn());
                    }}
                  >
                    {mode === "login" && (
                      <label>
                        {t("Сохранённые аккаунты")}
                        <select
                          value={offline}
                          onChange={(e) => {
                            setOffline(e.target.value);
                            const p = profiles.find(
                              (p) => p.id === e.target.value,
                            );
                            if (p) {
                              setServer(p.server);
                              setLogin(p.login);
                            }
                          }}
                        >
                          <option value="">{t("Онлайн-вход")}</option>
                          {accessibleProfiles.map((p) => (
                            <option value={p.id} key={p.id}>
                              {p.login} · {p.server} {t("· офлайн")}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {offline && (
                      <label>
                        {t("Сервер")}
                        <input readOnly value={server} dir="ltr" />
                      </label>
                    )}
                    {!offline && (
                      <>
                        <label>
                          {t("Сервер")}
                          {launch.pinned_server ? (
                            <input
                              value={launch.pinned_server}
                              readOnly
                              dir="ltr"
                            />
                          ) : (
                            <>
                              <select
                                value={otherServer ? "__new" : server}
                                onChange={(e) => {
                                  const custom = e.target.value === "__new";
                                  setOtherServer(custom);
                                  if (!custom) setServer(e.target.value);
                                  else setServer("");
                                }}
                              >
                                {launch.servers.map((value) => (
                                  <option key={value} value={value}>
                                    {value}
                                  </option>
                                ))}
                                <option value="__new">
                                  {t("Другой сервер…")}
                                </option>
                              </select>
                              {otherServer && (
                                <input
                                  aria-label={t("Адрес сервера")}
                                  value={server}
                                  onChange={(e) => setServer(e.target.value)}
                                  autoComplete="url"
                                  placeholder="https://vault.example.org"
                                  dir="ltr"
                                />
                              )}
                            </>
                          )}
                        </label>
                        <label>
                          {t("Логин")}
                          <input
                            value={login}
                            onChange={(e) => setLogin(e.target.value)}
                            autoComplete="username"
                          />
                        </label>
                      </>
                    )}
                    {mode === "register" && (
                      <label>
                        Email
                        <input
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          required
                        />
                      </label>
                    )}
                    <label>
                      {t("Пароль")}
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete={
                          mode === "register"
                            ? "new-password"
                            : "current-password"
                        }
                        required
                      />
                    </label>
                    {mode === "register" && (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={recovery}
                          onChange={(e) => setRecovery(e.target.checked)}
                        />
                        {t("Восстановление мастер-сертификатом")}
                      </label>
                    )}
                    <button
                      className="primary full"
                      disabled={
                        busy ||
                        certReady ||
                        !configured ||
                        !!launch.startup_error
                      }
                    >
                      {busy
                        ? t("Пожалуйста, подождите…")
                        : mode === "register"
                          ? t("Создать аккаунт")
                          : t("Открыть хранилище →")}
                    </button>
                  </form>
                )}
                {certReady && (
                  <button
                    className="secondary full"
                    onClick={() =>
                      run(async () => {
                        const saved = await call("save_certificate");
                        if (!saved) return;
                        setCertReady(false);
                        setNotice(
                          "Мастер-сертификат сохранён. Храните его отдельно.",
                        );
                      })
                    }
                  >
                    {t("Сохранить мастер-сертификат")}
                  </button>
                )}
                <div className="auth-links">
                  <button
                    disabled={
                      busy || certReady || !configured || !!launch.startup_error
                    }
                    onClick={() => {
                      setMode(mode === "register" ? "login" : "register");
                      setOffline("");
                      setError("");
                    }}
                  >
                    {" "}
                    {mode === "register"
                      ? t("У меня есть аккаунт")
                      : t("Создать аккаунт")}
                  </button>
                  <button
                    disabled={
                      busy || certReady || !configured || !!launch.startup_error
                    }
                    onClick={() =>
                      run(async () => {
                        if (!password)
                          throw new Error(
                            "Введите новый мастер-пароль в поле выше, затем выберите сертификат.",
                          );
                        const result = await call("recover_file", { password });
                        if (result) {
                          setPassword("");
                          setNotice("Пароль изменён. Войдите с новым паролем.");
                        }
                      })
                    }
                  >
                    {t("Восстановить доступ")}
                  </button>
                </div>
                <div className="local-warning">
                  {t("Прототип. Не сохраняйте настоящие секреты.")}
                </div>
              </section>
            </div>
          ) : (
            <>
              <section className="page-title">
                <div className="account-identity">
                  <strong>
                    <bdi>{status.login}</bdi>
                  </strong>
                  <span dir="ltr">{activeServer}</span>
                  {archive && <small>{t("Архив")}</small>}
                </div>
                <div className="page-actions">
                  <button
                    className="secondary"
                    disabled={busy || !status.online || needsSync}
                    onClick={() => requestLeave(() => beginGroup())}
                  >
                    {t("Создать группу")}
                  </button>
                  <button
                    className="primary"
                    disabled={busy || !status.online}
                    onClick={requestNew}
                  >
                    {t("＋ Добавить запись")}
                  </button>
                </div>
              </section>
              <div className="vault-grid">
                <section className="records-panel">
                  <div className="search">
                    <span>⌕</span>
                    <input
                      placeholder={t("Поиск по названию, группе или тегу")}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <div className="list-caption">
                    {t(kind ? types[kind].label : t("Все типы"))}
                    <span>
                      {t("Записи")}:{" "}
                      {new Intl.NumberFormat(language).format(
                        visibleCount(tree),
                      )}
                    </span>
                  </div>
                  {tree.length ? (
                    <EntryTree
                      reveal={treeReveal}
                      nodes={tree}
                      activeGroup={selectedGroup?.id ?? null}
                      selected={selected?.record_id}
                      onGroup={selectGroup}
                      onEntry={(entry) => requestLeave(() => open(entry))}
                      searching={!!query.trim()}
                    />
                  ) : (
                    <div className="empty">
                      <span>◇</span>
                      <h3>{t("Здесь пока тихо")}</h3>
                      <p>
                        {archive
                          ? t("Архивированные записи появятся здесь.")
                          : t(
                              "Добавьте первую запись — она будет зашифрована до отправки.",
                            )}
                      </p>
                    </div>
                  )}
                </section>
                <section className="detail-panel">
                  {groupDraft ? (
                    <GroupEditor
                      draft={groupDraft}
                      groups={groups.filter((g) => !g.archived)}
                      onChange={setGroupDraft}
                      onSave={() => {
                        void saveGroup();
                      }}
                      onCancel={() => requestLeave(() => setGroupDraft(null))}
                      disabled={busy || !status.online || needsSync}
                    />
                  ) : draft ? (
                    <>
                      <div className="detail-heading">
                        <h2>
                          {selected ? t("Редактирование") : t("Новая запись")}
                        </h2>
                        <button
                          className="subtle"
                          onClick={() =>
                            requestLeave(() => setDraft(undefined))
                          }
                        >
                          {t("Отмена")}
                        </button>
                      </div>
                      <TypePicker
                        value={draft.record_type}
                        disabled={!!selected}
                        onChange={(key) =>
                          requestLeave(() => {
                            setDraft({ ...empty(key), folder: draft.folder });
                            setCustomName("");
                          })
                        }
                      />
                      <label>
                        {t("Название")}
                        <input
                          value={draft.title}
                          onChange={(e) =>
                            setDraft({ ...draft, title: e.target.value })
                          }
                        />
                      </label>
                      {draft.record_type === "document" && (
                        <>
                          <label>
                            {t("Шаблон документа")}
                            <select
                              value={draft.fields.template ?? "custom"}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  fields: {
                                    ...draft.fields,
                                    template: e.target.value,
                                    kind: t(templateLabels[e.target.value]),
                                  },
                                })
                              }
                            >
                              {documentTemplates.map((key) => (
                                <option key={key} value={key}>
                                  {t(templateLabels[key])}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="check">
                            <input
                              type="checkbox"
                              checked={draft.fields.never_expires === "true"}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  fields: {
                                    ...draft.fields,
                                    never_expires: String(e.target.checked),
                                  },
                                })
                              }
                            />
                            {t("Бессрочный документ")}
                          </label>
                        </>
                      )}
                      {fieldsOf(draft)
                        .filter(
                          ([key]) =>
                            !(
                              draft.record_type === "document" &&
                              key === "expires" &&
                              draft.fields.never_expires === "true"
                            ),
                        )
                        .map(([key, title, secret, multiline]) => (
                          <label key={key}>
                            {key.startsWith("custom:") ? title : t(title)}
                            {multiline ? (
                              <textarea
                                rows={4}
                                className={secret ? "secret-input" : undefined}
                                spellCheck={false}
                                autoComplete="off"
                                value={draft.fields[key] ?? ""}
                                onChange={(e) =>
                                  setDraft({
                                    ...draft,
                                    fields: {
                                      ...draft.fields,
                                      [key]: e.target.value,
                                    },
                                  })
                                }
                              />
                            ) : (
                              <span
                                className={
                                  key === "password"
                                    ? "password-generator-field"
                                    : undefined
                                }
                              >
                                <input
                                  type={secret ? "password" : "text"}
                                  autoComplete="off"
                                  value={draft.fields[key] ?? ""}
                                  onChange={(e) =>
                                    setDraft({
                                      ...draft,
                                      fields: {
                                        ...draft.fields,
                                        [key]: e.target.value,
                                      },
                                    })
                                  }
                                />
                                {key === "password" && (
                                  <button
                                    type="button"
                                    className="secondary"
                                    disabled={
                                      busy || !status.online || needsSync
                                    }
                                    onClick={() => {
                                      try {
                                        const password =
                                          generatePassword(generator);
                                        setDraft({
                                          ...draft,
                                          fields: { ...draft.fields, password },
                                        });
                                      } catch {
                                        setError(
                                          t("Не удалось сгенерировать пароль."),
                                        );
                                      }
                                    }}
                                  >
                                    {t("Сгенерировать пароль")}
                                  </button>
                                )}
                              </span>
                            )}
                          </label>
                        ))}
                      {draft.record_type === "document" && (
                        <div className="two">
                          <label>
                            {t("Дополнительное поле")}
                            <input
                              value={customName}
                              onChange={(e) => setCustomName(e.target.value)}
                            />
                          </label>
                          <button
                            className="subtle"
                            disabled={
                              !customName.trim() ||
                              "custom:" + customName.trim() in draft.fields
                            }
                            onClick={() => {
                              setDraft({
                                ...draft,
                                fields: {
                                  ...draft.fields,
                                  ["custom:" + customName.trim()]: "",
                                },
                              });
                              setCustomName("");
                            }}
                          >
                            {t("Добавить поле")}
                          </button>
                        </div>
                      )}
                      <label>
                        {t("Заметки")}
                        <textarea
                          rows={4}
                          value={draft.notes}
                          onChange={(e) =>
                            setDraft({ ...draft, notes: e.target.value })
                          }
                        />
                      </label>
                      <div className="two">
                        <label>
                          {t("Группа")}
                          <select
                            value={draftGroup ?? ""}
                            onChange={(e) =>
                              setDraftGroup(e.target.value || null)
                            }
                          >
                            <option value="">{t("Корень списка")}</option>
                            {groups
                              .filter((g) => !g.archived)
                              .map((g) => (
                                <option key={g.id} value={g.id}>
                                  {groupLabel(g.id, groups)}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label>
                          {t("Теги через запятую")}
                          <input
                            value={draft.tags.join(", ")}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                tags: e.target.value
                                  .split(",")
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              })
                            }
                          />
                        </label>
                      </div>
                      <button
                        className="primary full"
                        disabled={
                          busy ||
                          needsSync ||
                          !status.online ||
                          !draft.title.trim()
                        }
                        onClick={save}
                      >
                        {t("Зашифровать и сохранить")}
                      </button>
                    </>
                  ) : selected ? (
                    <>
                      <div className="detail-heading">
                        <div>
                          <span className="eyebrow">
                            {t("ВЕРСИЯ")} {selected.revision}
                          </span>
                          <h2>
                            <bdi>{selected.data.title}</bdi>
                          </h2>
                        </div>
                        <span className="large-icon">
                          <Icon
                            name={selected.data.record_type}
                            label={t(currentType?.label ?? "Неизвестный тип")}
                          />
                        </span>
                      </div>
                      {fieldsOf(selected.data)
                        .filter(
                          ([key]) =>
                            !(
                              selected.data.record_type === "document" &&
                              key === "expires" &&
                              selected.data.fields.never_expires === "true"
                            ),
                        )
                        .map(([key, title, secret]) => {
                          const value = selected.data.fields[key];
                          return value ? (
                            <div className="field" key={key} data-field={key}>
                              <small>
                                {key.startsWith("custom:") ? title : t(title)}
                              </small>
                              <div>
                                <code>
                                  {secret && !revealed[key]
                                    ? "••••••••••••"
                                    : value}
                                </code>
                                <span>
                                  {secret && (
                                    <button
                                      className="subtle"
                                      onClick={() =>
                                        setRevealed({
                                          ...revealed,
                                          [key]: !revealed[key],
                                        })
                                      }
                                    >
                                      {revealed[key]
                                        ? t("Скрыть")
                                        : t("Показать")}
                                    </button>
                                  )}
                                  <button
                                    className="subtle"
                                    onClick={() => {
                                      void copy(selected, key);
                                    }}
                                  >
                                    {t("Копировать")}
                                  </button>
                                </span>
                              </div>
                            </div>
                          ) : null;
                        })}
                      {selected.data.record_type === "document" &&
                        selected.data.fields.never_expires === "true" && (
                          <p>{t("Бессрочный документ")}</p>
                        )}
                      {parentOf(selected.data, groups) && (
                        <p className="muted">
                          <bdi>
                            {groupLabel(
                              parentOf(selected.data, groups),
                              groups,
                            )}
                          </bdi>
                        </p>
                      )}
                      {selected.data.notes && (
                        <div className="field">
                          <small>{t("Заметки")}</small>
                          <p className="pre">{selected.data.notes}</p>
                        </div>
                      )}
                      <div className="tags">
                        {selected.data.tags.map((t) => (
                          <span key={t}>
                            <bdi>{t}</bdi>
                          </span>
                        ))}
                      </div>
                      {selected.received && (
                        <p className="muted">
                          {t("Владелец")}: <bdi>{selected.owner_login}</bdi> ·{" "}
                          {t("Только чтение")}
                        </p>
                      )}
                      {!selected.received ? (
                        <div className="actions">
                          <button
                            className="secondary"
                            disabled={
                              busy ||
                              !status.online ||
                              needsSync ||
                              selected.archived
                            }
                            onClick={() => setShareTarget(selected)}
                          >
                            {t("Поделиться")}
                            {selected.share_count
                              ? ` (${selected.share_count})`
                              : ""}
                          </button>
                          <button
                            className="secondary"
                            disabled={
                              busy || !status.online || needsSync || archive
                            }
                            onClick={() => (
                              setDraftGroup(parentOf(selected.data, groups)),
                              setDraft(structuredClone(selected.data))
                            )}
                          >
                            {t("Редактировать")}
                          </button>
                          <button
                            className="subtle"
                            onClick={() => {
                              void loadHistory(selected);
                            }}
                          >
                            {t("История")}
                          </button>
                          <button
                            className="subtle"
                            disabled={busy || !status.online || needsSync}
                            onClick={() => setArchived(!archive)}
                          >
                            {archive ? t("Вернуть из архива") : t("В архив")}
                          </button>
                        </div>
                      ) : (
                        <button
                          className="secondary"
                          disabled={busy || !status.online || needsSync}
                          onClick={() => setDismissTarget(selected)}
                        >
                          {t("Убрать у меня")}
                        </button>
                      )}
                      {!selected.received && history.length > 0 && (
                        <div className="history">
                          <h3>{t("История владельца")}</h3>
                          {history.map((v) => (
                            <HistoryVersion
                              key={v.version_id}
                              entry={v}
                              disabled={
                                busy ||
                                !status.online ||
                                needsSync ||
                                selected.archived
                              }
                              onRestore={() => {
                                void run(async () => {
                                  await call("save", {
                                    id: selected.record_id,
                                    expected_revision: selected.revision,
                                    data: v.data,
                                    archived: false,
                                  });
                                  setHistory([]);
                                  setSelected(undefined);
                                  await refresh();
                                });
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  ) : selectedGroup ? (
                    <div className="group-detail">
                      <Icon name="folder" />
                      <h2>
                        <bdi>{selectedGroup.title}</bdi>
                      </h2>
                      <p className="muted">
                        <bdi>{groupLabel(selectedGroup.id, groups)}</bdi>
                      </p>
                      <div className="actions">
                        <button
                          className="primary"
                          disabled={
                            busy ||
                            !status.online ||
                            needsSync ||
                            !!selectedGroup.archived
                          }
                          onClick={() =>
                            beginNew(kind || "login", selectedGroup.id)
                          }
                        >
                          {t("Добавить запись")}
                        </button>
                        <button
                          className="secondary"
                          disabled={
                            busy ||
                            !status.online ||
                            needsSync ||
                            !!selectedGroup.archived
                          }
                          onClick={() => beginGroup(selectedGroup.id)}
                        >
                          {t("Создать подгруппу")}
                        </button>
                        <button
                          className="secondary"
                          disabled={busy || !status.online || needsSync}
                          onClick={() =>
                            setArchiveRequest({
                              id: selectedGroup.id,
                              title: selectedGroup.title,
                              archived: !archive,
                            })
                          }
                        >
                          {t(archive ? "Вернуть из архива" : "В архив")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="empty detail-empty">
                      <span>⌁</span>
                      <h3>{t("Каждая деталь под защитой")}</h3>
                      <p>
                        {t("Выберите запись слева,")}
                        <br />
                        {t("чтобы посмотреть её содержимое.")}
                      </p>
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

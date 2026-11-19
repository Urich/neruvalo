import { TotpDisplay, TotpEditor } from "./Totp";
import { DateInput, dateField, displayDate } from "./DateInput";
import { passwordExpired } from "./model";
import { SecretInput, SecretTextarea } from "./SecretInput";
import { EntryIcon, IconEditor } from "./RecordIcon";
import { useDisabledHints } from "./disabledHints";
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { HistoryVersion } from "./HistoryVersion";
import { Attachments } from "./Attachments";
import { ConfirmNewEntry } from "./ConfirmNewEntry";
import { VerificationFrame } from "./VerificationFrame";
import { useI18n, setSystemLocale } from "./i18n";
import { Icon } from "./Icon";
import { ArchiveDialog } from "./ArchiveDialog";
import { About } from "./About";
import { TypePicker } from "./TypePicker";
import { generatePassword, normalizeGenerator } from "./passwordGenerator";
import { DismissShare } from "./DismissShare";
import { ShareDialog, Recipient, VerifiedContact } from "./ShareDialog";
import { AccountPage } from "./AccountPage";
import { LocalVaultTools } from "./LocalVaultTools";
import { Settings } from "./Settings";
import { Imports } from "./Imports";
import { ContextMenu, MenuItem } from "./ContextMenu";
import {
  Group,
  groupsFor,
  parentOf,
  groupLabel,
  entryTree,
  archiveSelection,
  archiveMembers,
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
import { Data, Entry, Profile, types, empty, errorText, isUnsupportedVaultFormat } from "./model";
type Status = {
  unlocked: boolean;
  online?: boolean;
  local?: boolean;
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
  const [transferSource, setTransferSource] = useState("");
  const [page, setPage] = useState<"vault" | "account" | "imports" | "settings" | "about">("vault");
  const [treeReveal, setTreeReveal] = useState(0);
  const [savedGroups, setSavedGroups] = useState<Group[]>([]);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [draftGroup, setDraftGroup] = useState<string | null>(null);
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null);
  const [customName, setCustomName] = useState("");
  const [totpInvalid, setTotpInvalid] = useState(false);
  const [invalidDates, setInvalidDates] = useState<Set<string>>(new Set());
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
  const statusProfile = useRef(status.profile);
  statusProfile.current = status.profile;
  useEffect(() => {
    if (transferSource && status.unlocked && status.online && !status.local) setPage("imports");
  }, [transferSource, status.unlocked, status.online, status.local]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [server, setServer] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<"login" | "register" | "verify">("login");
  const [verificationSlot, setVerificationSlot] = useState<HTMLDivElement | null>(null);
  const [offline, setOffline] = useState("");
  const offlineProfile = transferSource ? "" : offline;
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(true);
  const [ticket, setTicket] = useState("");
  const [certReady, setCertReady] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState(false);
  const [recordsRevision, setRecordsRevision] = useState(0);
  const [indexLoading, setIndexLoading] = useState(false);
  const lazyRecords = useRef({ queue: new Map<string, Entry>(), running: false });
  const openingRecord = useRef(0);
  const refreshingIndex = useRef(false);
  const [shareView, setShareView] = useState<"own" | "outgoing" | "received">(
    "own",
  );
  const [received, setReceived] = useState<Entry[]>([]);
  const [outgoing, setOutgoing] = useState<any[]>([]);
  const [dismissTarget, setDismissTarget] = useState<Entry | null>(null);
  const [shareTarget, setShareTarget] = useState<{ entry: Entry; contact?: VerifiedContact } | null>(null);
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
  const [pendingArchive, setPendingArchive] = useState<Set<string> | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [needsSync, setNeedsSync] = useState(false);
  const [timeout, setTimeoutSeconds] = useState(60);
  const [clipboardSeconds, setClipboardSeconds] = useState<number>(() =>
    readLocal("neruvalo.clipboardSeconds", 30),
  );
  const generation = useRef(0);
  const detailPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (detailPanel.current) detailPanel.current.scrollTop = 0;
  }, [selected?.record_id, !!draft, draft?.record_type, !!groupDraft, activeGroup]);
  const lastTouch = useRef(0);
  const wasUnlocked = useRef(false);
  const clear = () => {
    wasUnlocked.current = false;
    generation.current++;
    setStatus({ unlocked: false });
    setTotpInvalid(false);
    setEntries([]);
    lazyRecords.current = { queue: new Map(), running: false };
    openingRecord.current++;
    setRecordsLoading(false);
    setIndexLoading(false);
    refreshingIndex.current = false;
    setRecordsError(false);
    setReceived([]);
    setOutgoing([]);
    setShareTarget(null);
    setDismissTarget(null);
    setShareView("own");
    setSelected(undefined);
    setDraft(undefined);
    setPendingNew(null);
    setArchiveRequest(null);
    setPendingArchive(null);
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
  async function rejectUnsupportedVault(error: unknown) {
    if (!isUnsupportedVaultFormat(error) && !/VAULT_INTEGRITY|VAULT_ROLLBACK|VAULT_RESOURCE_LIMIT/.test(String(error))) return false;
    await call("lock").catch(() => {});
    // clear() also advances the generation, invalidating pending secret-bearing responses.
    clear();
    setTransferSource("");
    setMode("login");
    setError(errorText(error));
    return true;
  }
  async function run(task: () => Promise<void>) {
    const epoch = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (e) {
      if (epoch !== generation.current) return;
      if (await rejectUnsupportedVault(e)) return;
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
    const loadState = { queue: new Map<string, Entry>(), running: false };
    lazyRecords.current = loadState;
    setRecordsLoading(false);
    setRecordsError(false);
    setIndexLoading(true);
    refreshingIndex.current = true;
    try {
      const s = await call<Status>("status");
      if (epoch !== generation.current || lazyRecords.current !== loadState) return;
      if (!s.unlocked) {
        if (wasUnlocked.current) clear(); else setStatus(s);
        return;
      }
      // Keep the unlock screen visible until all vault data passes the initial load.
      const [list, groups, sharing] = await Promise.all([
        call<Entry[]>("list", { expected_profile: s.profile, summaries: true }),
        call<Group[]>("groups", { expected_profile: s.profile }),
        call("sharing", { expected_profile: s.profile }),
      ]);
      if (epoch !== generation.current || lazyRecords.current !== loadState) return;
      wasUnlocked.current = true;
      setStatus(s);
      setTimeoutSeconds(s.timeout_seconds ?? 60);
      const shareCounts = new Map<string,number>();
      for (const share of sharing?.outgoing ?? []) shareCounts.set(share.record_id,(shareCounts.get(share.record_id) ?? 0)+1);
      const owned = list.map((entry) => ({...entry,share_count:shareCounts.get(entry.record_id) ?? 0}));
      setEntries(owned);
      setRecordsRevision(value => value + 1);
      setReceived((previous) => {
        const next = sharing?.incoming ?? [];
        if (
          next.some(
            (e: Entry) => !previous.some((old) => old.record_id === e.record_id),
          )
        )
          setNotice("ui.youHaveReceivedAccessToANewEntry");
        return next;
      });
      setOutgoing(sharing?.outgoing ?? []);
      if (sharing?.notifications?.length)
        setNotice("ui.youHaveReceivedAccessToANewEntry");
      setSelected((current) =>
        current?.received
          ? (sharing?.incoming ?? []).find(
              (e: Entry) => e.record_id === current.record_id,
            )
          : current
            ? (() => { const next = owned.find((e) => e.record_id === current.record_id); return next?.summary ? (next.version_id === current.version_id ? { ...current, share_count: next.share_count } : undefined) : next; })()
            : current,
      );
      setSavedGroups(groups ?? []);
    } catch (error) {
      if (epoch === generation.current && lazyRecords.current === loadState) await rejectUnsupportedVault(error);
      throw error;
    } finally { if (lazyRecords.current === loadState) { refreshingIndex.current = false; if (epoch === generation.current) setIndexLoading(false); } }
  }
  function loadVisibleRecords(requested: Entry[]) {
    const state = lazyRecords.current;
    const epoch = generation.current;
    for (const entry of requested) if (entry.summary && !entry.row_loaded) state.queue.set(entry.record_id, entry);
    if (state.running || !state.queue.size) return;
    state.running = true;
    setRecordsLoading(true); setRecordsError(false);
    void (async () => {
      try {
        while (state.queue.size) {
          const batch = [...state.queue.values()].slice(0,50);
          batch.forEach(entry => state.queue.delete(entry.record_id));
          const loaded = await call<Entry[]>("list_records", { ids: batch.map(entry => entry.record_id), list_view: true, expected_profile: status.profile });
          if (epoch !== generation.current || state !== lazyRecords.current) return;
          const records = new Map(loaded.map(entry => [entry.record_id,entry]));
          const versions = new Map(batch.map(entry => [entry.record_id,entry.version_id]));
          setEntries(current => current.map(entry => {
            const row = records.get(entry.record_id);
            return row && entry.version_id === versions.get(entry.record_id) ? { ...row, share_count: entry.share_count } : entry;
          }));
        }
      } catch (error) {
        if (epoch === generation.current && state === lazyRecords.current && !await rejectUnsupportedVault(error)) { setRecordsError(true); setError(errorText(error)); }
      } finally {
        state.running = false;
        if (epoch === generation.current && state === lazyRecords.current) setRecordsLoading(false);
      }
    })();
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
        if (config.startup_error) setError("ui.checkLaunchArguments");
        setConfigured(true);
      })
      .catch((e) => setError(errorText(e)));
    call<Profile[]>("profiles")
      .then(setProfiles)
      .catch((e) => setError(errorText(e)));
    void refresh().catch(e => setError(errorText(e)));
    const timer = setInterval(() => {
      const epoch = generation.current;
      call<Status>("status")
        .then((s) => {
          if (epoch !== generation.current) return;
          if (!s.unlocked) {
            if (wasUnlocked.current) clear();
          } else if (!wasUnlocked.current || s.profile !== statusProfile.current) {
            if (!refreshingIndex.current) void refresh().catch(e => setError(errorText(e)));
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
      if (epoch === generation.current) setNotice("ui.copied");
    });
  }
  const accessibleProfiles = profiles.filter(
    (p) => p.local || !launch.pinned_server || p.server === launch.pinned_server,
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
        { label: t("ui.undo"), action: edit("undo") },
        { label: t("ui.redo"), action: edit("redo") },
        {
          label: t("ui.cut"),
          disabled: input.readOnly || start === end,
          action: edit("cut"),
        },
        {
          label: t("ui.copy"),
          disabled: start === end,
          action: edit("copy"),
        },
        {
          label: t("ui.paste"),
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
          label: t("ui.selectAll"),
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
              label: t("ui.addEntryLabel"),
              disabled: busy || !(status.online || status.local) || needsSync || !!group.archived,
              action: safe(() =>
                requestLeave(() => beginNew(kind || "login", group.id)),
              ),
            },
            {
              label: t("ui.createSubgroup"),
              disabled: busy || !(status.online || status.local) || needsSync || !!group.archived,
              action: safe(() => requestLeave(() => beginGroup(group.id))),
            },
            {
              label: t(archive ? "ui.restoreFromArchive" : "ui.archiveEntry"),
              disabled: busy || !(status.online || status.local) || needsSync,
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
          items.push(copyItem("login", t("ui.copyUsername")));
        if (fieldsOf(record.data).some((f) => f[0] === "password"))
          items.push(copyItem("password", t("ui.copyPassword")));
        if (field) items.push(copyItem(field, t("ui.copyField")));
        if (record.received) {
          items.push(
            {
              label: t("ui.open"),
              action: safe(() => requestLeave(() => open(record))),
            },
            {
              label: t("ui.removeForMe"),
              disabled: busy || !(status.online || status.local) || needsSync,
              action: safe(() => requestLeave(() => setDismissTarget(record))),
            },
          );
          setMenu({ x, y, items });
          return;
        }
        items.push({
          label: t("ui.share"),
          disabled: busy || !status.online || needsSync || record.archived,
          action: safe(() => requestLeave(() => setShareTarget({ entry: record }))),
        });
        items.push(
          {
            label: t("ui.open"),
            action: safe(() => requestLeave(() => open(record))),
          },
          {
            label: t("ui.edit"),
            disabled: busy || !(status.online || status.local) || needsSync || record.archived,
            action: safe(() =>
              requestLeave(() => {
                open(record, true);
              }),
            ),
          },
          {
            label: t("ui.history"),
            disabled: busy,
            action: safe(() =>
              requestLeave(() => {
                open(record, false, true);
              }),
            ),
          },
          {
            label: t(record.archived ? t("ui.restoreFromArchive") : t("ui.archiveEntry")),
            disabled: busy || !(status.online || status.local) || needsSync,
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
    openingRecord.current++;
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
  function open(entry: Entry, editing = false, history = false) {
    const selection = ++openingRecord.current;
    const epoch = generation.current;
    const show = (record: Entry) => {
      if (epoch !== generation.current || selection !== openingRecord.current) return;
      setGroupDraft(null);
      const parent = parentOf(record.data, groups);
      setActiveGroup(parent); setDraftGroup(parent); setCustomName("");
      setTotpInvalid(false);
      setSelected(record); setDraft(editing ? structuredClone(record.data) : undefined);
      setHistory([]); setRevealed({});
      if (history) void loadHistory(record);
    };
    if (!entry.summary) { show(entry); return; }
    void run(async () => {
      const values = await call<Entry[]>("list_records", { ids: [entry.record_id], expected_profile: status.profile });
      const record = values.find(value => value.record_id === entry.record_id);
      if (!record) throw new Error("ui.recordUnavailable");
      show({ ...record, share_count: entry.share_count });
    });
  }
  function beginNew(recordType: string, parent: string | null = activeGroup) {
    setTotpInvalid(false);
    openingRecord.current++;
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
      !(status.online || status.local) ||
      busy
    )
      return;
    beginNew(pending.kind);
  }
  async function signIn() {
    await run(async () => {
      if ((!configured || launch.startup_error) && !profiles.find((p) => p.id === offlineProfile)?.local)
        throw new Error("ui.checkLaunchArguments");
      if (certReady) throw new Error("ui.saveTheRecoveryFileFirst");
      if (offlineProfile) await call("unlock_offline", { id: offlineProfile, password });
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
        server, login, email, password,
        with_recovery: recovery,
      });
      setTicket(r.ticket);
      setPassword("");
      setMode("verify");
    });
  }
  function returnToRegistration() {
    setMode("register");
    setPassword("");
    setCode("");
    setTicket("");
    setCertReady(false);
  }
  async function cancelRegistration() {
    if (busy) return;
    await run(async () => {
      await call("register_cancel");
      returnToRegistration();
    });
  }
  async function finishRegistration() {
    if (busy || !code.trim()) return;
    await run(async () => {
      try {
        await call("register_finish", { server, code });
      } catch (error) {
        if (errorText(error) === "ui.registrationRestartRequired") {
          returnToRegistration();
          setLogin("");
          setEmail("");
          setRecovery(true);
        }
        throw error;
      }
      setCertReady(recovery);
      setMode("login");
      setCode("");
      setTicket("");
      setNotice(
        recovery
          ? "ui.accountCreatedSaveTheRecoveryFileBeforeSigningInThisFileCannotBeRetrievedAfterTheApplicationCloses"
          : "ui.accountCreatedYouCanNowSignIn",
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
      setNotice("ui.allChangesDownloaded");
    });
  }
  useDisabledHints(t(busy ? "ui.pleaseWait" : needsSync ? "ui.synchronizeAndReopenTheEntryBeforeSaving" : status.unlocked && !(status.online || status.local) ? "ui.offlineAccessIsReadOnly" : "ui.actionUnavailable"));
  const unchanged = !!draft && !!selected && JSON.stringify(draft) === JSON.stringify(selected.data) && draftGroup === (selected.data.group_id ?? null);
  async function save() {
    if (!draft || unchanged || totpInvalid || invalidDates.size) return;
    const invalidDate = detailPanel.current?.querySelector<HTMLInputElement>("input:invalid");
    if (invalidDate) { invalidDate.reportValidity(); return; }
    await run(async () => {
      const result = await call("save", {
        id: selected?.record_id ?? null,
        expected_revision: selected?.revision ?? 0,
        data: draft,
        group: draftGroup,
        archived: selected?.archived ?? false,
      });
      const saved = result?.record as Entry | undefined;
      if (!saved) throw new Error("ui.recordUnavailable");
      setEntries(current => {
        const previous = current.find(entry => entry.record_id === saved.record_id);
        const updated = {...saved,share_count:previous?.share_count ?? 0};
        return previous ? current.map(entry => entry.record_id === saved.record_id ? updated : entry) : [...current,updated];
      });
      if (result.groups) setSavedGroups(result.groups);
      setActiveGroup(result?.group_id ?? draftGroup);
      if (!selected) setArchive(false);
      if (kind && kind !== draft.record_type) setKind("");
      setQuery("");
      setDraft(undefined);
      setSelected({...saved,share_count:selected?.share_count ?? 0});
      setRevealed({});
      setHistory([]);
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
    if (!archiveRequest || busy || pendingArchive) return;
    const request = archiveRequest;
    const epoch = generation.current;
    const members = archiveMembers(request.id, groups, entries);
    setArchiveRequest(null);
    setPendingArchive(members);
    if (selected && members.has(selected.record_id)) {
      setSelected(undefined);
      setHistory([]);
      setRevealed({});
    }
    if (activeGroup && members.has(activeGroup)) setActiveGroup(null);
    try {
      await run(async () => {
        await call("archive_tree", {
          id: request.id,
          archived: request.archived,
        });
        if (epoch !== generation.current) return;
        await refresh();
      });
    } finally {
      if (epoch === generation.current) setPendingArchive(null);
    }
  }

  const groups = useMemo(() => groupsFor(entries, savedGroups), [entries, savedGroups]);
  const displayedEntries = useMemo(() => entries.filter((entry) => !pendingArchive?.has(entry.record_id)), [entries, pendingArchive]);
  const tree = useMemo(() => entryTree(
    shareView === "received" ? [] : groups.filter((group) => !pendingArchive?.has(group.id)),
    shareView === "received"
      ? received
      : displayedEntries.filter((e) => shareView !== "outgoing" || !!e.share_count),
    query,
    kind,
    shareView === "received" ? false : archive,
    shareView === "outgoing",
  ), [groups, displayedEntries, received, query, kind, archive, shareView, pendingArchive]);
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
  const networkProfile = status.unlocked && !status.local ? status.profile : undefined;
  const canShare = !!networkProfile && !!status.online && !busy && !needsSync;
  const resolveContact = (code: string) => call<Recipient>("resolve_share_contact", { code });
  const currentType = types[(draft ?? selected?.data)?.record_type ?? "login"];
  const localTools = (<LocalVaultTools
        onUnsupportedVault={rejectUnsupportedVault}
        status={status} profiles={profiles} source={transferSource} busy={busy}
        toolbar={status.unlocked}
        onSource={setTransferSource}
        onChanged={async () => { await refresh(); setProfiles(await call("profiles")); }}
        onConnect={async () => {
          const source = status.profile!;
          await call("lock");
          clear();
          const destination = launch.pinned_server ?? launch.servers[0] ?? "";
          setServer(destination);
          setOtherServer(!destination);
          setLogin("");
          setTransferSource(source);
          setMode("login");
        }}
      />);
  return (
    <div
      className={status.unlocked && page === "vault" ? "app vault-screen" : "app"}
      lang={language}
      dir={language === "ar" ? "rtl" : "ltr"}
      onContextMenu={context}
      onKeyDown={(e) => {
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
          context(e);
      }}
    >
      <VerificationFrame target={verificationSlot} />
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
          title={shareTarget.entry.data.title}
          wallet={shareTarget.entry.data.record_type === "crypto_wallet"}
          recipients={outgoing.filter(
            (g) => g.record_id === shareTarget.entry.record_id,
          )}
          disabled={!canShare}
          onClose={() => setShareTarget(null)}
          onResolve={(login) => call<Recipient>("resolve_recipient", { login })}
          resolveContact={resolveContact}
          initialContact={shareTarget.contact}
          onCreate={async (login, code) => {
            const id = shareTarget.entry.record_id;
            if (code) await call("share_to_contact", { id, code });
            else await call("share_change", { kind: "create", id, target: login });
            await refresh();
          }}
          onRevoke={async (id) => {
            await call("share_change", {
              kind: "revoke",
              id: shareTarget.entry.record_id,
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
        {!status.unlocked && (
          <button
            type="button"
            className={page === "vault" ? "nav active" : "nav"}
            aria-current={page === "vault" ? "page" : undefined}
            onClick={() => setPage("vault")}
          >
            <Icon name="login" /> <span>{t("ui.unlockVault")}</span>
          </button>
        )}
        {status.unlocked && (
          <>
            <button
              className={page === "vault" && !archive && shareView === "own" ? "nav active" : "nav"}
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
              <Icon name="all" /> <span>{t("ui.allEntries")}</span>
              <b>{displayedEntries.filter((e) => !e.archived).length}</b>
            </button>
            <button
              className={page === "vault" && archive ? "nav active" : "nav"}
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
              <Icon name="archive" /> <span>{t("ui.archive")}</span>
            </button>
            {!status.local && (["outgoing", "received"] as const).map((view) => (
              <button
                key={view}
                aria-label={t(
                  view === "outgoing" ? "ui.sharedByMe" : "ui.received",
                )}
                className={page === "vault" && shareView === view ? "nav active" : "nav"}
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
                  {t(view === "outgoing" ? "ui.sharedByMe" : "ui.received")}
                </span>
                <b>
                  {view === "received"
                    ? received.length
                    : displayedEntries.filter((e) => e.share_count).length}
                </b>
              </button>
            ))}
            <div className="nav-gap" />
            {Object.entries(types).map(([key]) => (
              <button
                key={key}
                className={page === "vault" && kind === key ? "nav active" : "nav"}
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
                  {t(key === "document" ? t("ui.documents") : types[key].label)}
                </span>
              </button>
            ))}
          </>
        )}
        <div className="sidebar-bottom">
          {networkProfile && (
            <button className={page === "account" ? "nav active" : "nav"}
              aria-current={page === "account" ? "page" : undefined}
              onClick={() => requestLeave(() => setPage("account"))}>
              <Icon name="account" /><span>{t("ui.accountPage")}</span>
            </button>
          )}
          {status.unlocked && (
            <button className={page === "imports" ? "nav active" : "nav"}
              aria-current={page === "imports" ? "page" : undefined}
              onClick={() => requestLeave(() => setPage("imports"))}>
              <Icon name="import" /><span>{t("ui.imports")}</span>
            </button>
          )}
          <button
            className={page === "settings" ? "nav active" : "nav"}
            onClick={() => setPage(page === "settings" ? "vault" : "settings")}
          >
            <Icon name="settings" />
            <span>{t("ui.settings")}</span>
          </button>
          <button
            className={page === "about" ? "nav active" : "nav"}
            onClick={() => setPage(page === "about" ? "vault" : "about")}
          >
            <Icon name="info" />
            <span>{t("ui.about")}</span>
          </button>
          <div className="sidebar-foot">
            <span className="shield">◇</span>
            <p>
              {t("ui.yourSecretsAreEncrypted")}
              <br />
              {t("ui.onYourDevice")}
            </p>
          </div>
        </div>
      </aside>
      <main>
        <header className={status.unlocked ? "vault-toolbar" : undefined}>
          <div className="breadcrumb">
            {t("ui.personalSpace")}
            <span>/</span> {t(page === "account" ? "ui.accountPage" : page === "imports" ? "ui.imports" : archive ? "ui.archive" : "ui.vault")}
          </div>
          <div className="connection">
            <i className={status.online ? "online" : ""} />
            {status.unlocked
              ? status.local ? t("ui.localVault") : status.online
                ? t("ui.online")
                : t("ui.offlineReadOnly")
              : t("ui.locked")}
          </div>
          {status.unlocked && (
            <>
              {localTools}
              {!status.local && <button
                className="subtle"
                disabled={busy}
                onClick={() =>
                  requestLeave(() => {
                    void sync();
                  })
                }
              >
                {t("ui.synchronize")}
              </button>}
              <button
                className="subtle"
                onClick={() => {
                  void call("lock");
                  clear();
                }}
              >
                {t("ui.lock")}
              </button>
            </>
          )}
        </header>
        <div className="content">
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
          ) : page === "account" && networkProfile ? (
            <AccountPage key={networkProfile} profile={networkProfile} login={status.login ?? ""}
              server={activeServer} canShare={canShare} records={entries} resolveContact={resolveContact}
              onShare={(entry, contact) => setShareTarget({ entry, contact })} />
          ) : page === "imports" ? (
            <Imports onUnsupportedVault={rejectUnsupportedVault} status={status} profiles={profiles} source={transferSource} busy={busy || needsSync}
              onSource={setTransferSource} onChanged={async () => { await refresh(); setProfiles(await call("profiles")); }} />
          ) : page === "settings" ? (
            <div>
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
              server={status.local ? t("ui.localVault") : activeServer}
              online={status.online || status.local}
              local={status.local}
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
            </div>
          ) : !status.unlocked ? (
            <div className="auth-layout">
              <section className="intro">
                <div className="eyebrow">
                  {t("ui.yourSecretsYourControl")}
                </div>
                <h1>
                  {t("ui.everythingThatMatters")}
                  <br />
                  <em>{t("ui.onlyYours")}</em>
                </h1>
                <p>
                  {t("ui.passwordsCardsKeysAndPersonalNotes")}
                  <br />
                  {t("ui.oneProtectedSpaceOnYourServer")}
                </p>
                <div className="intro-line" />
                <div className="facts">
                  <span>{t("ui.clientSideEncryption")}</span>
                  <span>{t("ui.openSource")}</span>
                  <span>{t("ui.offlineViewing")}</span>
                </div>
              </section>
              <section className="auth-card">
                <div className="card-symbol">◇</div>
                <h2>
                  {mode === "verify"
                    ? t("ui.verifyEmail")
                    : mode === "register"
                      ? t("ui.createAccount")
                      : t("ui.unlockVault")}
                </h2>
                {mode === "verify" && <p className="muted">
                  {t("ui.emailIsSavedInServerOutbox")}
                </p>}
                {mode === "verify" ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void finishRegistration();
                    }}
                  >
                    <label>
                      {t("ui.emailCode")}
                      <input
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    <p className="ticket">
                      {t("ui.emailFile")}
                      {ticket}.txt
                    </p>
                    <div className="auth-links">
                      <button type="submit" className="primary" disabled={busy || !code.trim()}>
                        {t("ui.confirm")}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => void cancelRegistration()}
                      >
                        {t("ui.cancel")}
                      </button>
                    </div>
                  </form>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (busy) return;
                      void (mode === "register" ? register() : signIn());
                    }}
                  >
                    {mode === "login" && !transferSource && (
                      <label>
                        {t("ui.savedAccounts")}
                        <select
                          value={offlineProfile}
                          onChange={(e) => {
                            setOffline(e.target.value);
                            const p = profiles.find(
                              (p) => p.id === e.target.value,
                            );
                            if (p && !p.local) {
                              setServer(p.server);
                              setLogin(p.login);
                            }
                          }}
                        >
                          <option value="">{t("ui.onlineSignIn")}</option>
                          {accessibleProfiles.map((p) => (
                            <option value={p.id} key={p.id}>
                              {p.login} · {p.local ? t("ui.localVault") : `${p.server} ${t("ui.offline")}`}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {offlineProfile && !profiles.find((p) => p.id === offlineProfile)?.local && (
                      <label>
                        {t("ui.server")}
                        <input readOnly value={server} dir="ltr" />
                      </label>
                    )}
                    {!offlineProfile && (
                      <>
                        <label>
                          {t("ui.server")}
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
                                  {t("ui.otherServer")}
                                </option>
                              </select>
                              {otherServer && (
                                <input
                                  aria-label={t("ui.serverAddress")}
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
                          {t("ui.username")}
                          <input
                            value={login}
                            onChange={(e) => setLogin(e.target.value)}
                            autoComplete="username"
                            required={mode === "login"}
                            aria-describedby={mode === "register" ? "registration-login-help" : undefined}
                          />
                          {mode === "register" && <small id="registration-login-help">{t("ui.loginRequirements")}</small>}
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
                      {t("ui.password")}
                      <SecretInput
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
                        {t("ui.recoveryWithSecretFile")}
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
                        ? t("ui.pleaseWait")
                        : mode === "register"
                          ? t("ui.createAccount")
                          : t("ui.unlockVaultLabel")}
                    </button>
                    <div ref={setVerificationSlot} />
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
                          "ui.recoveryFileSavedKeepItSeparately",
                        );
                      })
                    }
                  >
                    {t("ui.saveRecoveryFile")}
                  </button>
                )}
                {mode !== "verify" && <div className="auth-links">
                  <button
                    type="button"
                    className="secondary"
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
                      ? t("ui.iHaveAnAccount")
                      : t("ui.createAccount")}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={
                      busy || certReady || !configured || !!launch.startup_error
                    }
                    onClick={() =>
                      run(async () => {
                        if (!password)
                          throw new Error(
                            "ui.enterANewPasswordAboveThenChooseYourRecoveryFile",
                          );
                        const result = await call("recover_file", { password });
                        if (result) {
                          setPassword("");
                          setNotice("ui.passwordChangedSignInWithTheNewPassword");
                        }
                      })
                    }
                  >
                    {t("ui.recoverAccess")}
                  </button>
                </div>}
                {mode !== "verify" && <div className="auth-local-actions">{localTools}</div>}
              </section>
            </div>
          ) : (
            <>
              <section className="page-title">
                <div className="account-identity">
                  <strong>
                    <bdi>{status.login}</bdi>
                  </strong>
                  <span dir={status.local ? undefined : "ltr"}>{status.local ? t("ui.localVault") : activeServer}</span>
                  {archive && <small>{t("ui.archive")}</small>}
                </div>
                <div className="page-actions">
                  <button
                    className="secondary"
                    disabled={busy || !(status.online || status.local) || needsSync}
                    onClick={() => requestLeave(() => beginGroup())}
                  >
                    {t("ui.createGroup")}
                  </button>
                  <button
                    className="primary"
                    disabled={busy || !(status.online || status.local)}
                    onClick={requestNew}
                  >
                    {t("ui.addEntry")}
                  </button>
                </div>
              </section>
              <div className="vault-grid">
                <section className="records-panel">
                  <div className="search">
                    <span>⌕</span>
                    <input
                      placeholder={t("ui.searchTitleGroupOrTag")}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <div className="list-caption">
                    {t(kind ? types[kind].label : t("ui.allTypes"))}
                    <span>
                      {t("ui.entries")}:{" "}
                      {new Intl.NumberFormat(language).format(
                        visibleCount(tree),
                      )}
                    </span>
                  </div>
                  {indexLoading && <div role="status" className="records-loading"><span className="loading-spinner" aria-hidden="true" />{t("ui.loadingRecords")}</div>}
                  {tree.length ? (
                    <EntryTree
                      loadKey={recordsRevision}
                      loading={recordsLoading}
                      loadFailed={recordsError}
                      onVisibleEntries={loadVisibleRecords}
                      resetKey={`${status.profile}-${query}-${kind}-${archive}-${shareView}`}
                      reveal={treeReveal}
                      nodes={tree}
                      activeGroup={selectedGroup?.id ?? null}
                      selected={selected?.record_id}
                      onGroup={selectGroup}
                      onEntry={(entry) => requestLeave(() => open(entry))}
                      searching={!!query.trim()}
                    />
                  ) : (
                    !indexLoading && <div className="empty">
                      <span>◇</span>
                      <h3>{t("ui.noEntriesHereYet")}</h3>
                      <p>
                        {archive
                          ? t("ui.archivedEntriesWillAppearHere")
                          : t(
                              "ui.addYourFirstEntryItWillBeEncryptedBeforeBeingSent",
                            )}
                      </p>
                    </div>
                  )}
                </section>
                <section className="detail-panel" ref={detailPanel}>
                  {groupDraft ? (
                    <GroupEditor
                      draft={groupDraft}
                      groups={groups.filter((g) => !g.archived)}
                      onChange={setGroupDraft}
                      onSave={() => {
                        void saveGroup();
                      }}
                      onCancel={() => requestLeave(() => setGroupDraft(null))}
                      disabled={busy || !(status.online || status.local) || needsSync}
                    />
                  ) : draft ? (
                    <>
                      <div className="detail-heading">
                        <h2>
                          {selected ? t("ui.editing") : t("ui.newEntry")}
                        </h2>
                        <button
                          className="subtle"
                          onClick={() =>
                            requestLeave(() => setDraft(undefined))
                          }
                        >
                          {t("ui.cancel")}
                        </button>
                      </div>
                      <TypePicker
                        value={draft.record_type}
                        disabled={!!selected}
                        onChange={(key) =>
                          requestLeave(() => {
                            setTotpInvalid(false);
                            setDraft({ ...empty(key), folder: draft.folder, ...(draft.attachments ? { attachments: draft.attachments, schema_version: 2 } : {}) });
                            setCustomName("");
                          })
                        }
                      />
                      <label>
                        {t("ui.title")}
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
                            {t("ui.documentTemplate")}
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
                        </>
                      )}
                      {fieldsOf(draft)
                        .filter(([key]) => key !== "totp")
                        .map(([key, title, secret, multiline]) => {
                          const FieldInput = secret ? SecretInput : "input";
                          const FieldTextarea = secret ? SecretTextarea : "textarea";
                          return (
                          <label key={key}>
                            {key.startsWith("custom:") ? title : t(title)}
                            {multiline ? (
                              <FieldTextarea
                                rows={4}
                                className={secret ? "secret-input" : undefined}
                                spellCheck={false}
                                autoComplete="off"
                                value={key === "expires" && draft.record_type !== "bank_card" && draft.fields.never_expires === "true" ? "" : draft.fields[key] ?? ""}
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
                                    : "record-input-row"
                                }
                              >
                                {dateField(draft.record_type,key) ? <DateInput
                                  key={`${selected?.record_id ?? "new"}-${draft.record_type}-${key}`}
                                  month={draft.record_type === "bank_card"}
                                  onValidity={valid => setInvalidDates(previous => {
                                    const field = `${selected?.record_id ?? "new"}-${draft.record_type}-${key}`;
                                    if (previous.has(field) === !valid) return previous;
                                    const next = new Set(previous); if (valid) next.delete(field); else next.add(field); return next;
                                  })}
                                  value={key === "expires" && draft.record_type !== "bank_card" && draft.fields.never_expires === "true" ? "" : draft.fields[key] ?? ""}
                                  onValueChange={value => setDraft(current => current ? {...current,fields:{...current.fields,[key]:value,...(key === "expires" && current.record_type !== "bank_card" ? {never_expires:String(!value)} : {})}} : current)} /> : (
                                <FieldInput
                                  type="text"
                                  autoComplete="off"
                                  value={key === "expires" && draft.record_type !== "bank_card" && draft.fields.never_expires === "true" ? "" : draft.fields[key] ?? ""}
                                  onChange={(e) =>
                                    setDraft({
                                      ...draft,
                                      fields: {
                                        ...draft.fields,
                                        [key]: e.target.value,
                                        ...(key === "expires" && draft.record_type !== "bank_card" ? {never_expires: String(!e.target.value)} : {}),
                                      },
                                    })
                                  }
                                />
                                )}
                                {key === "password" && (
                                  <button
                                    type="button"
                                    className="secondary"
                                    disabled={
                                      busy || !(status.online || status.local) || needsSync
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
                                          t("ui.couldNotGenerateAPassword"),
                                        );
                                      }
                                    }}
                                  >
                                    {t("ui.generatePassword")}
                                  </button>
                                )}
                              </span>
                            )}
                          </label>
                          );
                        })}
                      {(draft.record_type === "login" || !!draft.fields.totp) && <TotpEditor
                        key={`totp-${status.profile}-${selected?.record_id ?? "new"}-${draft.record_type}`}
                        value={draft.fields.totp ?? ""} profile={status.profile}
                        onValidity={valid => setTotpInvalid(!valid)}
                        onChange={value => setDraft(current => current ? {...current,fields:{...current.fields,totp:value}} : current)} />}
                      {draft.record_type === "document" && (
                        <div className="two">
                          <label>
                            {t("ui.customField")}
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
                            {t("ui.addField")}
                          </button>
                        </div>
                      )}
                      <label>
                        {t("ui.notes")}
                        <textarea
                          rows={4}
                          value={draft.notes}
                          onChange={(e) =>
                            setDraft({ ...draft, notes: e.target.value })
                          }
                        />
                      </label>
                      <Attachments key={`draft-${status.profile}-${selected?.record_id ?? "new"}`} items={draft.attachments} profile={status.profile}
                        disabled={busy || needsSync || !(status.online || status.local)}
                        onChange={(attachments) => setDraft({ ...draft, schema_version: 2, attachments })} />
                      <div className="two">
                        <label>
                          {t("ui.group")}
                          <select
                            value={draftGroup ?? ""}
                            onChange={(e) =>
                              setDraftGroup(e.target.value || null)
                            }
                          >
                            <option value="">{t("ui.topLevel")}</option>
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
                          {t("ui.tagsCommaSeparated")}
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
                      <IconEditor
                        key={`icon-${status.profile}-${selected?.record_id ?? "new"}`}
                        name={draft.record_type}
                        value={draft.icon}
                        builtin={draft.keepass_icon_id}
                        onChange={(icon) => setDraft(current => current ? { ...current, icon, keepass_icon_id: undefined } : current)}
                      />
                      <button
                        className="primary full"
                        disabled={
                          busy ||
                          needsSync ||
                          !(status.online || status.local) ||
                          !draft.title.trim() || unchanged || totpInvalid || !!invalidDates.size
                        }
                        title={invalidDates.size ? t("ui.invalidDate") : totpInvalid ? t("ui.invalidTotp") : unchanged ? t("ui.noChanges") : !draft.title.trim() ? t("ui.recordTitleRequired") : undefined}
                        onClick={save}
                      >
                        {t("ui.encryptAndSave")}
                      </button>
                    </>
                  ) : selected ? (
                    <>
                      <div className="detail-heading">
                        <div>
                          <span className="eyebrow">
                            {t("ui.version")} {selected.revision}
                          </span>
                          <h2>
                            <bdi>{selected.data.title}</bdi>
                            {passwordExpired(selected.data) && <span className="expired-indicator" role="img" aria-label={t("ui.passwordExpired")} title={t("ui.passwordExpired")}><Icon name="expired" /></span>}
                          </h2>
                        </div>
                        <span className="large-icon">
                          <EntryIcon data={selected.data}
                            name={selected.data.record_type}
                            label={t(currentType?.label ?? "ui.unknownType")}
                          />
                        </span>
                      </div>
                      <dl className="record-dates">{([['created_at', 'createdDate'], ['modified_at', 'modifiedDate'], ['archived_at', 'archivedDate']] as const).filter(([key]) => key !== 'archived_at' || selected.archived || selected.data.archived_at).map(([key, label]) => <div key={key}><dt>{t(`ui.${label}`)}</dt><dd>{selected.data[key] != null ? new Date(selected.data[key]! * 1000).toLocaleString(language) : t("ui.unknownDate")}</dd></div>)}</dl>
                      {selected.data.fields.totp && <TotpDisplay key={`${status.profile}-${selected.record_id}-${selected.version_id}`} entry={selected} profile={status.profile} clipboardSeconds={clipboardSeconds} onCopied={() => setNotice("ui.copied")} />}
                      {fieldsOf(selected.data)
                        .filter(([key]) => key !== "totp")
                        .filter(
                          ([key]) =>
                            !(
                              ["login", "document"].includes(selected.data.record_type) &&
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
                                    : dateField(selected.data.record_type,key) ? displayDate(value,selected.data.record_type === "bank_card") : value}
                                </code>
                                <span>
                                  {secret && (
                                    <button
                                      className="subtle secret-toggle"
                                      aria-label={t(revealed[key] ? "ui.hide" : "ui.show")}
                                      title={t(revealed[key] ? "ui.hide" : "ui.show")}
                                      aria-pressed={!!revealed[key]}
                                      onClick={() =>
                                        setRevealed({
                                          ...revealed,
                                          [key]: !revealed[key],
                                        })
                                      }
                                    >
                                      <Icon name={revealed[key] ? "eye_off" : "eye"} />
                                    </button>
                                  )}
                                  <button
                                    className="subtle"
                                    onClick={() => {
                                      void copy(selected, key);
                                    }}
                                  >
                                    {t("ui.copy")}
                                  </button>
                                </span>
                              </div>
                            </div>
                          ) : null;
                        })}
                      {["login", "document"].includes(selected.data.record_type) &&
                        (selected.data.fields.never_expires === "true" || !selected.data.fields.expires) && (
                          <p>{t("ui.noExpiryDate")}</p>
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
                      <Attachments key={`${status.profile}-${selected.record_id}-${selected.version_id}`} items={selected.data.attachments} profile={status.profile} disabled={busy} />
                      {selected.data.notes && (
                        <div className="field">
                          <small>{t("ui.notes")}</small>
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
                          {t("ui.owner")}: <bdi>{selected.owner_login}</bdi> ·{" "}
                          {t("ui.readOnly")}
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
                            onClick={() => setShareTarget({ entry: selected })}
                          >
                            {t("ui.share")}
                            {selected.share_count
                              ? ` (${selected.share_count})`
                              : ""}
                          </button>
                          <button
                            className="secondary"
                            disabled={
                              busy || !(status.online || status.local) || needsSync || archive
                            }
                            onClick={() => (
                              setDraftGroup(parentOf(selected.data, groups)),
                              setDraft(structuredClone(selected.data))
                            )}
                          >
                            {t("ui.edit")}
                          </button>
                          <button
                            className="subtle"
                            onClick={() => {
                              void loadHistory(selected);
                            }}
                          >
                            {t("ui.history")}
                          </button>
                          <button
                            className="subtle"
                            disabled={busy || !(status.online || status.local) || needsSync}
                            onClick={() => setArchived(!archive)}
                          >
                            {archive ? t("ui.restoreFromArchive") : t("ui.archiveEntry")}
                          </button>
                        </div>
                      ) : (
                        <button
                          className="secondary"
                          disabled={busy || !(status.online || status.local) || needsSync}
                          onClick={() => setDismissTarget(selected)}
                        >
                          {t("ui.removeForMe")}
                        </button>
                      )}
                      {!selected.received && history.length > 0 && (
                        <div className="history">
                          <h3>{t("ui.ownerHistory")}</h3>
                          {history.map((v) => (
                            <HistoryVersion
                              key={v.version_id}
                              entry={v}
                              profile={status.profile}
                              disabled={
                                busy ||
                                !(status.online || status.local) ||
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
                      <EntryIcon name="folder" data={selectedGroup} />
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
                            !(status.online || status.local) ||
                            needsSync ||
                            !!selectedGroup.archived
                          }
                          onClick={() =>
                            beginNew(kind || "login", selectedGroup.id)
                          }
                        >
                          {t("ui.addEntryLabel")}
                        </button>
                        <button
                          className="secondary"
                          disabled={
                            busy ||
                            !(status.online || status.local) ||
                            needsSync ||
                            !!selectedGroup.archived
                          }
                          onClick={() => beginGroup(selectedGroup.id)}
                        >
                          {t("ui.createSubgroup")}
                        </button>
                        <button
                          className="secondary"
                          disabled={busy || !(status.online || status.local) || needsSync}
                          onClick={() =>
                            setArchiveRequest({
                              id: selectedGroup.id,
                              title: selectedGroup.title,
                              archived: !archive,
                            })
                          }
                        >
                          {t(archive ? "ui.restoreFromArchive" : "ui.archiveEntry")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="empty detail-empty">
                      <span>⌁</span>
                      <h3>{t("ui.everyDetailProtected")}</h3>
                      <p>
                        {t("ui.chooseAnEntryOnTheLeft")}
                        <br />
                        {t("ui.toViewItsContents")}
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

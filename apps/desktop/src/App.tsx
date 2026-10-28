import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { HistoryVersion } from "./HistoryVersion";
import {
  Data,
  Entry,
  Profile,
  types,
  empty,
  filterEntries,
  errorText,
} from "./model";
type Status = {
  unlocked: boolean;
  online?: boolean;
  login?: string;
  timeout_seconds?: number;
};
async function call<T = any>(
  action: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return invoke("command", { request: { action, ...args } });
}
export default function App() {
  const [status, setStatus] = useState<Status>({ unlocked: false });
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [server, setServer] = useState("http://127.0.0.1:8787");
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
  const [selected, setSelected] = useState<Entry>();
  const [draft, setDraft] = useState<Data>();
  const [history, setHistory] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [archive, setArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [needsSync, setNeedsSync] = useState(false);
  const [timeout, setTimeoutSeconds] = useState(60);
  const [clipboardSeconds, setClipboardSeconds] = useState(30);
  const generation = useRef(0);
  const lastTouch = useRef(0);
  const wasUnlocked = useRef(false);
  const clear = () => {
    wasUnlocked.current = false;
    generation.current++;
    setStatus({ unlocked: false });
    setEntries([]);
    setSelected(undefined);
    setDraft(undefined);
    setHistory([]);
    setPassword("");
    setRevealed({});
    setCode("");
    setCertReady(false);
  };
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (e) {
      setError(errorText(e));
      if (
        String(e).includes("RECORD_VERSION_MISMATCH") ||
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
    if (!s.unlocked) {
      clear();
      return;
    }
    const list = await call<Entry[]>("list");
    if (epoch !== generation.current) return;
    wasUnlocked.current = true;
    setStatus(s);
    setTimeoutSeconds(s.timeout_seconds ?? 60);
    setEntries(list);
  }
  useEffect(() => {
    call<Profile[]>("profiles")
      .then(setProfiles)
      .catch(() =>
        setError(
          "Откройте приложение через Tauri. Страница в браузере не является клиентом Neruvalo.",
        ),
      );
    const timer = setInterval(() => {
      call<Status>("status")
        .then((s) => {
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
  }, [status.unlocked]);
  function open(entry: Entry) {
    setSelected(entry);
    setDraft(undefined);
    setHistory([]);
    setRevealed({});
  }
  async function signIn() {
    await run(async () => {
      if (certReady) throw new Error("Сначала сохраните мастер-сертификат.");
      if (offline) await call("unlock_offline", { id: offline, password });
      else await call("login", { server, login, password });
      setPassword("");
      setNeedsSync(false);
      await refresh();
      setProfiles(await call("profiles"));
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
      await refresh();
      setNotice("Все изменения загружены.");
    });
  }
  async function save() {
    if (!draft) return;
    await run(async () => {
      await call("save", {
        id: selected?.record_id ?? null,
        expected_revision: selected?.revision ?? 0,
        data: draft,
        archived: selected?.archived ?? false,
      });
      setDraft(undefined);
      setSelected(undefined);
      await refresh();
    });
  }
  async function setArchived(value: boolean) {
    if (!selected) return;
    await run(async () => {
      await call("save", {
        id: selected.record_id,
        expected_revision: selected.revision,
        data: selected.data,
        archived: value,
      });
      setSelected(undefined);
      setHistory([]);
      await refresh();
    });
  }
  const visible = filterEntries(entries, query, kind, archive);
  const currentType = types[(draft ?? selected?.data)?.record_type ?? "login"];
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">n</span>
          <div>
            Neruvalo<small>YOUR PRIVATE SPACE</small>
          </div>
        </div>
        <div className="stage">PROTOTYPE · 0.1</div>
        <div className="nav-label">ХРАНИЛИЩЕ</div>
        <button
          className={!archive ? "nav active" : "nav"}
          onClick={() => {
            setArchive(false);
            setSelected(undefined);
          }}
        >
          ◈ <span>Все записи</span>
          <b>{entries.filter((e) => !e.archived).length}</b>
        </button>
        <button
          className={archive ? "nav active" : "nav"}
          onClick={() => {
            setArchive(true);
            setSelected(undefined);
          }}
        >
          ▧ <span>Архив</span>
        </button>
        <div className="nav-label">ТИПЫ ЗАПИСЕЙ</div>
        {Object.entries(types).map(([key, t]) => (
          <button
            key={key}
            className={kind === key ? "nav active" : "nav"}
            onClick={() => setKind(kind === key ? "" : key)}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
        <div className="sidebar-foot">
          <span className="shield">◇</span>
          <p>
            Ваши секреты шифруются
            <br />
            на вашем устройстве.
          </p>
          <small>Только тестовые данные</small>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            Личное пространство <span>/</span> {archive ? "Архив" : "Хранилище"}
          </div>
          <div className="connection">
            <i className={status.online ? "online" : ""} />
            {status.unlocked
              ? status.online
                ? "На связи"
                : "Офлайн · только чтение"
              : "Заблокировано"}
          </div>
          {status.unlocked && (
            <>
              <button className="subtle" disabled={busy} onClick={sync}>
                ↻ Синхронизировать
              </button>
              <button
                className="subtle"
                onClick={() => {
                  void call("lock");
                  clear();
                }}
              >
                Заблокировать
              </button>
            </>
          )}
        </header>
        <div className="content">
          {error && (
            <div className="banner error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="banner notice" role="status">
              {notice}
            </div>
          )}
          {!status.unlocked ? (
            <div className="auth-layout">
              <section className="intro">
                <div className="eyebrow">СЕКРЕТЫ ПОД ВАШИМ КОНТРОЛЕМ</div>
                <h1>
                  Всё важное.
                  <br />
                  <em>Только ваше.</em>
                </h1>
                <p>
                  Пароли, карты, ключи и личные записи.
                  <br />
                  Одно защищённое пространство на вашем сервере.
                </p>
                <div className="intro-line" />
                <div className="facts">
                  <span>◎ Клиентское шифрование</span>
                  <span>⌁ Открытый исходный код</span>
                  <span>▤ Офлайн-просмотр</span>
                </div>
              </section>
              <section className="auth-card">
                <div className="card-symbol">◇</div>
                <h2>
                  {mode === "verify"
                    ? "Подтвердите email"
                    : mode === "register"
                      ? "Создать аккаунт"
                      : "Открыть хранилище"}
                </h2>
                <p className="muted">
                  {mode === "verify"
                    ? "В прототипе письмо записано в закрытый dev-outbox сервера."
                    : "Мастер-пароль остаётся на вашем устройстве."}
                </p>
                {mode === "verify" ? (
                  <>
                    <label>
                      Код из письма
                      <input
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    <p className="ticket">Файл письма: {ticket}.txt</p>
                    <button
                      className="primary full"
                      disabled={busy || !code}
                      onClick={finishRegistration}
                    >
                      Подтвердить
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
                        Сохранённые аккаунты
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
                          <option value="">Онлайн-вход</option>
                          {profiles.map((p) => (
                            <option value={p.id} key={p.id}>
                              {p.login} · офлайн
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {!offline && (
                      <>
                        <label>
                          Ваш сервер
                          <input
                            value={server}
                            onChange={(e) => setServer(e.target.value)}
                            autoComplete="url"
                          />
                        </label>
                        <label>
                          Логин
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
                      Мастер-пароль
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
                        Восстановление мастер-сертификатом
                      </label>
                    )}
                    <button
                      className="primary full"
                      disabled={busy || certReady}
                    >
                      {busy
                        ? "Пожалуйста, подождите…"
                        : mode === "register"
                          ? "Создать аккаунт"
                          : "Открыть хранилище →"}
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
                    Сохранить мастер-сертификат
                  </button>
                )}
                <div className="auth-links">
                  <button
                    disabled={busy || certReady}
                    onClick={() => {
                      setMode(mode === "register" ? "login" : "register");
                      setOffline("");
                      setError("");
                    }}
                  >
                    {" "}
                    {mode === "register"
                      ? "У меня есть аккаунт"
                      : "Создать аккаунт"}
                  </button>
                  <button
                    disabled={busy || certReady}
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
                    Восстановить доступ
                  </button>
                </div>
                <div className="local-warning">
                  Прототип. Не сохраняйте настоящие секреты.
                </div>
              </section>
            </div>
          ) : (
            <>
              <section className="page-title">
                <div>
                  <div className="eyebrow">{status.login} / ЛИЧНОЕ</div>
                  <h1>{archive ? "Архив" : "Ваше хранилище"}</h1>
                  <p className="muted">Тихое место для важных вещей.</p>
                </div>
                <button
                  className="primary"
                  disabled={busy || !status.online}
                  onClick={() => {
                    setSelected(undefined);
                    setHistory([]);
                    setDraft(empty(kind || "login"));
                  }}
                >
                  ＋ Добавить запись
                </button>
              </section>
              <div className="vault-grid">
                <section className="records-panel">
                  <div className="search">
                    <span>⌕</span>
                    <input
                      placeholder="Поиск по названию, папке или тегу"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <div className="list-caption">
                    {kind ? types[kind].label : "Все типы"}
                    <span>{visible.length} записей</span>
                  </div>
                  {visible.length ? (
                    visible.map((e) => (
                      <button
                        key={e.record_id}
                        className={
                          selected?.record_id === e.record_id
                            ? "record selected"
                            : "record"
                        }
                        onClick={() => open(e)}
                      >
                        <span className="record-icon">
                          {types[e.data.record_type]?.icon ?? "?"}
                        </span>
                        <span>
                          <strong>{e.data.title}</strong>
                          <small>
                            {types[e.data.record_type]?.label ??
                              "Неизвестный тип"}
                            {e.data.folder ? " · " + e.data.folder : ""}
                          </small>
                        </span>
                        <span className="arrow">›</span>
                      </button>
                    ))
                  ) : (
                    <div className="empty">
                      <span>◇</span>
                      <h3>Здесь пока тихо</h3>
                      <p>
                        {archive
                          ? "Архивированные записи появятся здесь."
                          : "Добавьте первую запись — она будет зашифрована до отправки."}
                      </p>
                    </div>
                  )}
                </section>
                <section className="detail-panel">
                  {draft ? (
                    <>
                      <div className="detail-heading">
                        <h2>{selected ? "Редактирование" : "Новая запись"}</h2>
                        <button
                          className="subtle"
                          onClick={() => setDraft(undefined)}
                        >
                          Отмена
                        </button>
                      </div>
                      <label>
                        Тип
                        <select
                          disabled={!!selected}
                          value={draft.record_type}
                          onChange={(e) => setDraft(empty(e.target.value))}
                        >
                          {Object.entries(types).map(([key, t]) => (
                            <option key={key} value={key}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Название
                        <input
                          value={draft.title}
                          onChange={(e) =>
                            setDraft({ ...draft, title: e.target.value })
                          }
                        />
                      </label>
                      {currentType.fields.map(([key, title, secret]) => (
                        <label key={key}>
                          {title}
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
                        </label>
                      ))}
                      <label>
                        Заметки
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
                          Папка
                          <input
                            value={draft.folder}
                            onChange={(e) =>
                              setDraft({ ...draft, folder: e.target.value })
                            }
                          />
                        </label>
                        <label>
                          Теги через запятую
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
                        Зашифровать и сохранить
                      </button>
                    </>
                  ) : selected ? (
                    <>
                      <div className="detail-heading">
                        <div>
                          <span className="eyebrow">
                            ВЕРСИЯ {selected.revision}
                          </span>
                          <h2>{selected.data.title}</h2>
                        </div>
                        <span className="large-icon">{currentType.icon}</span>
                      </div>
                      {currentType.fields.map(([key, title, secret]) => {
                        const value = selected.data.fields[key];
                        return value ? (
                          <div className="field" key={key}>
                            <small>{title}</small>
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
                                    {revealed[key] ? "Скрыть" : "Показать"}
                                  </button>
                                )}
                                <button
                                  className="subtle"
                                  onClick={() =>
                                    run(async () => {
                                      await call("copy_field", {
                                        id: selected.record_id,
                                        field: key,
                                        seconds: clipboardSeconds,
                                      });
                                      setNotice("Скопировано.");
                                    })
                                  }
                                >
                                  Копировать
                                </button>
                              </span>
                            </div>
                          </div>
                        ) : null;
                      })}
                      {selected.data.notes && (
                        <div className="field">
                          <small>Заметки</small>
                          <p className="pre">{selected.data.notes}</p>
                        </div>
                      )}
                      <div className="tags">
                        {selected.data.tags.map((t) => (
                          <span key={t}>{t}</span>
                        ))}
                      </div>
                      <div className="actions">
                        <button
                          className="secondary"
                          disabled={
                            busy || !status.online || needsSync || archive
                          }
                          onClick={() =>
                            setDraft(structuredClone(selected.data))
                          }
                        >
                          Редактировать
                        </button>
                        <button
                          className="subtle"
                          onClick={() =>
                            run(async () =>
                              setHistory(
                                await call("history", {
                                  id: selected.record_id,
                                }),
                              ),
                            )
                          }
                        >
                          История
                        </button>
                        <button
                          className="subtle"
                          disabled={busy || !status.online || needsSync}
                          onClick={() => setArchived(!archive)}
                        >
                          {archive ? "Вернуть из архива" : "В архив"}
                        </button>
                      </div>
                      {history.length > 0 && (
                        <div className="history">
                          <h3>История владельца</h3>
                          {history.map((v) => (
                            <HistoryVersion
                              key={v.version_id}
                              entry={v}
                              disabled={busy || !status.online || needsSync}
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
                  ) : (
                    <div className="empty detail-empty">
                      <span>⌁</span>
                      <h3>Каждая деталь под защитой</h3>
                      <p>
                        Выберите запись слева,
                        <br />
                        чтобы посмотреть её содержимое.
                      </p>
                    </div>
                  )}
                </section>
              </div>
              <footer className="settings">
                <label>
                  Блокировка
                  <select
                    value={timeout}
                    disabled={!status.online || busy}
                    onChange={(e) =>
                      run(async () => {
                        const seconds = Number(e.target.value);
                        await call("settings", { seconds });
                        setTimeoutSeconds(seconds);
                      })
                    }
                  >
                    <option value={60}>Через 1 минуту</option>
                    <option value={300}>Через 5 минут</option>
                    <option value={900}>Через 15 минут</option>
                    <option value={0}>Никогда</option>
                  </select>
                </label>
                <label>
                  Очистка буфера
                  <select
                    value={clipboardSeconds}
                    onChange={(e) =>
                      setClipboardSeconds(Number(e.target.value))
                    }
                  >
                    <option value={30}>Через 30 секунд</option>
                    <option value={60}>Через 1 минуту</option>
                    <option value={120}>Через 2 минуты</option>
                    <option value={0}>Не очищать</option>
                  </select>
                </label>
                <span>
                  История сохраняется. Получатель общего доступа пока не
                  реализован.
                </span>
              </footer>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

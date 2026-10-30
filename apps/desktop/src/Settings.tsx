import { GeneratorSettings } from "./GeneratorSettings";
import { GeneratorOptions } from "./passwordGenerator";
import { useState } from "react";
import { languages, useI18n } from "./i18n";
import {
  defaultShortcuts,
  fromEvent,
  isMobile,
  sameShortcut,
  Shortcut,
  Shortcuts,
  shortcutText,
} from "./preferences";
export function Settings({
  login,
  server,
  online,
  busy,
  timeout,
  clipboard,
  onTimeout,
  onClipboard,
  shortcuts,
  onShortcuts,
  generator,
  onGenerator,
}: {
  generator: GeneratorOptions;
  onGenerator: (value: GeneratorOptions) => void;
  login?: string;
  server: string;
  online?: boolean;
  busy: boolean;
  timeout: number;
  clipboard: number;
  onTimeout: (seconds: number) => void;
  onClipboard: (seconds: number) => void;
  shortcuts: Shortcuts;
  onShortcuts: (s: Shortcuts) => void;
}) {
  const { t, preference, setPreference } = useI18n();
  const [capture, setCapture] = useState<"login" | "password" | null>(null);
  const [error, setError] = useState("");
  return (
    <section className="settings-page">
      <h1>{t("Настройки")}</h1>
      {login && (
        <>
          <h2>{t("Учётная запись")}</h2>
          <p>
            <bdi>{login}</bdi> · <bdi>{server}</bdi>
          </p>
          <h2>{t("Безопасность")}</h2>
          <label>
            {t("Блокировка")}
            <select
              value={timeout}
              disabled={!online || busy}
              onChange={(e) => onTimeout(Number(e.target.value))}
            >
              {[60, 300, 900, 0].map((s) => (
                <option key={s} value={s}>
                  {s ? t("Минуты") + ": " + s / 60 : t("Никогда")}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            {t("Настройка аккаунта · сохраняется на сервере")}
          </p>
          <label>
            {t("Очистка буфера")}
            <select
              value={clipboard}
              onChange={(e) => onClipboard(Number(e.target.value))}
            >
              {[30, 60, 120, 0].map((s) => (
                <option key={s} value={s}>
                  {s ? t("Секунды") + ": " + s : t("Не очищать")}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">{t("Настройка этого устройства")}</p>
        </>
      )}
      <GeneratorSettings value={generator} onChange={onGenerator} />
      <h2>{t("Интерфейс")}</h2>
      <label>
        {t("Язык")}
        <select
          value={preference}
          onChange={(e) => setPreference(e.target.value)}
        >
          <option value="auto">{t("Автоматически — язык системы")}</option>
          {Object.entries(languages).map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">{t("Настройка этого устройства")}</p>
      {login && !isMobile() && (
        <>
          <h2>{t("Сочетания клавиш")}</h2>
          <p className="muted">
            {t("Действуют только в окне приложения вне полей ввода")}
          </p>
          {(["login", "password"] as const).map((action) => (
            <div key={action} className="shortcut-row">
              <span>
                {t(
                  action === "login"
                    ? "Скопировать логин"
                    : "Скопировать пароль",
                )}
              </span>
              <button
                className="secondary"
                data-shortcut-capture
                onClick={() => {
                  setCapture(action);
                  setError("");
                }}
                onKeyDown={(e) => {
                  if (capture !== action) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.key === "Escape") {
                    setCapture(null);
                    return;
                  }
                  const key = fromEvent(e.nativeEvent);
                  if (!key) {
                    setError(
                      "Выберите сочетание Ctrl или Alt с буквой, цифрой или функциональной клавишей",
                    );
                    return;
                  }
                  if (
                    sameShortcut(
                      key,
                      shortcuts[action === "login" ? "password" : "login"],
                    )
                  ) {
                    setError("Это сочетание уже используется");
                    return;
                  }
                  onShortcuts({ ...shortcuts, [action]: key });
                  setCapture(null);
                  setError("");
                }}
              >
                {capture === action
                  ? t("Нажмите сочетание · Esc — отмена")
                  : shortcutText(shortcuts[action] as Shortcut)}
              </button>
              <button
                className="subtle"
                onClick={() => {
                  onShortcuts({ ...shortcuts, [action]: null });
                  setCapture(null);
                }}
              >
                {t("Убрать")}
              </button>
            </div>
          ))}
          {error && <p role="alert">{t(error)}</p>}
          <button
            className="secondary"
            onClick={() => {
              onShortcuts(structuredClone(defaultShortcuts));
              setCapture(null);
              setError("");
            }}
          >
            {t("Сбросить сочетания")}
          </button>
        </>
      )}
    </section>
  );
}

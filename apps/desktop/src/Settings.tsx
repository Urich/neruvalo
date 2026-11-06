import { ProxySettings, ProxyResult, ProxyConfig } from "./ProxySettings";
import { GeneratorSettings } from "./GeneratorSettings";
import { GeneratorOptions } from "./passwordGenerator";
import { useState } from "react";
import { languages, useI18n } from "./i18n";
import { themes, useTheme } from "./theme";
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
  local,
  busy,
  timeout,
  clipboard,
  onTimeout,
  onClipboard,
  shortcuts,
  onShortcuts,
  generator,
  onGenerator,
  loadProxy,
  saveProxy,
}: {
  loadProxy: () => Promise<ProxyResult>;
  saveProxy: (value: ProxyConfig) => Promise<void>;
  generator: GeneratorOptions;
  onGenerator: (value: GeneratorOptions) => void;
  login?: string;
  server: string;
  online?: boolean;
  local?: boolean;
  busy: boolean;
  timeout: number;
  clipboard: number;
  onTimeout: (seconds: number) => void;
  onClipboard: (seconds: number) => void;
  shortcuts: Shortcuts;
  onShortcuts: (s: Shortcuts) => void;
}) {
  const { t, preference, setPreference } = useI18n();
  const { theme, setTheme } = useTheme();
  const [capture, setCapture] = useState<"login" | "password" | null>(null);
  const [error, setError] = useState("");
  return (
    <section className="settings-page">
      <h1>{t("ui.settings")}</h1>
      {login && (
        <>
          <h2>{t("ui.account")}</h2>
          <p>
            <bdi>{login}</bdi> · <bdi>{server}</bdi>
          </p>
          <h2>{t("ui.security")}</h2>
          <label>
            {t("ui.lockTimeout")}
            <select
              value={timeout}
              disabled={!online || busy}
              onChange={(e) => onTimeout(Number(e.target.value))}
            >
              {[60, 300, 900, 0].map((s) => (
                <option key={s} value={s}>
                  {s ? t("ui.minutes") + ": " + s / 60 : t("ui.never")}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            {t(local ? "ui.settingForThisDevice" : "ui.accountSettingSavedOnServer")}
          </p>
          <label>
            {t("ui.clearClipboard")}
            <select
              value={clipboard}
              onChange={(e) => onClipboard(Number(e.target.value))}
            >
              {[30, 60, 120, 0].map((s) => (
                <option key={s} value={s}>
                  {s ? t("ui.seconds") + ": " + s : t("ui.doNotClear")}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">{t("ui.settingForThisDevice")}</p>
        </>
      )}
      <ProxySettings load={loadProxy} save={saveProxy} disabled={busy} />
      <GeneratorSettings value={generator} onChange={onGenerator} />
      <h2>{t("ui.interface")}</h2>
      <label>
        {t("ui.theme")}
        <select value={theme} onChange={(e) => setTheme(e.target.value)}>
          {themes.map((value) => (
            <option key={value} value={value}>{t(`ui.theme.${value}`)}</option>
          ))}
        </select>
      </label>
      <p className="muted">{t("ui.settingForThisDevice")}</p>
      <label>
        {t("ui.language")}
        <select
          value={preference}
          onChange={(e) => setPreference(e.target.value)}
        >
          <option value="auto">{t("ui.automaticSystemLanguage")}</option>
          {Object.entries(languages).map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">{t("ui.settingForThisDevice")}</p>
      {login && !isMobile() && (
        <>
          <h2>{t("ui.keyboardShortcuts")}</h2>
          <p className="muted">
            {t("ui.onlyInThisWindowOutsideTextInputs")}
          </p>
          {(["login", "password"] as const).map((action) => (
            <div key={action} className="shortcut-row">
              <span>
                {t(
                  action === "login"
                    ? "ui.copyUsername"
                    : "ui.copyPassword",
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
                      "ui.chooseCtrlOrAltWithALetterDigitOrFunctionKey",
                    );
                    return;
                  }
                  if (
                    sameShortcut(
                      key,
                      shortcuts[action === "login" ? "password" : "login"],
                    )
                  ) {
                    setError("ui.shortcutAlreadyInUse");
                    return;
                  }
                  onShortcuts({ ...shortcuts, [action]: key });
                  setCapture(null);
                  setError("");
                }}
              >
                {capture === action
                  ? t("ui.pressShortcutEscToCancel")
                  : shortcutText(shortcuts[action] as Shortcut)}
              </button>
              <button
                className="subtle"
                onClick={() => {
                  onShortcuts({ ...shortcuts, [action]: null });
                  setCapture(null);
                }}
              >
                {t("ui.remove")}
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
            {t("ui.resetShortcuts")}
          </button>
        </>
      )}
    </section>
  );
}

import { useEffect, useState } from "react";
import { useI18n } from "./i18n";
export type ProxyConfig = {
  mode: string;
  url: string;
  username: string;
  password: string;
};
export type ProxyResult = {
  settings: ProxyConfig;
  protected_credentials: boolean;
};
export function ProxySettings({
  load,
  save,
  disabled,
}: {
  load: () => Promise<ProxyResult>;
  save: (value: ProxyConfig) => Promise<void>;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState<ProxyConfig | null>(null);
  const [protectedCredentials, setProtected] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    load()
      .then((result) => {
        if (active && result?.settings) {
          setValue(result.settings);
          setProtected(result.protected_credentials);
        }
      })
      .catch(() => {
        if (active) setError("ui.couldNotLoadProxySettings");
      });
    return () => {
      active = false;
    };
  }, []);
  const change = (next: ProxyConfig) => {
    setValue(next);
    setSaved(false);
    setError("");
  };
  return (
    <section className="proxy-settings">
      <h2>{t("ui.proxy")}</h2>
      <p className="muted">
        {t(
          "ui.settingsAreSavedOnlyOnThisDeviceAndAreNotSentToTheServer",
        )}
      </p>
      {value && (
        <>
          <label>
            {t("ui.serverConnection")}
            <select
              value={value.mode}
              disabled={working || disabled}
              onChange={(e) => change({ ...value, mode: e.target.value })}
            >
              <option value="system">{t("ui.automatic")}</option>
              <option value="direct">{t("ui.noProxy")}</option>
              <option value="manual">{t("ui.manualProxy")}</option>
            </select>
          </label>
          {value.mode === "manual" && (
            <>
              <label>
                {t("ui.proxyAddress")}
                <input
                  dir="ltr"
                  maxLength={2048}
                  placeholder="socks5h://127.0.0.1:10808"
                  autoComplete="off"
                  value={value.url}
                  disabled={working || disabled}
                  onChange={(e) => change({ ...value, url: e.target.value })}
                />
              </label>
              <p className="muted">HTTP, HTTPS, SOCKS5, SOCKS5h</p>
              {protectedCredentials && (
                <>
                  <label>
                    {t("ui.proxyUsername")}
                    <input
                      autoComplete="off"
                      value={value.username}
                      disabled={working || disabled}
                      onChange={(e) =>
                        change({ ...value, username: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    {t("ui.proxyPassword")}
                    <input
                      type="password"
                      autoComplete="off"
                      value={value.password}
                      disabled={working || disabled}
                      onChange={(e) =>
                        change({ ...value, password: e.target.value })
                      }
                    />
                  </label>
                  <p className="muted">
                    {t(
                      "ui.onWindowsProxySettingsAndPasswordAreProtectedByTheCurrentUserSDPAPI",
                    )}
                  </p>
                </>
              )}
            </>
          )}
          <button
            className="secondary"
            disabled={
              working ||
              disabled ||
              (value.mode === "manual" && !value.url.trim())
            }
            onClick={() => {
              setWorking(true);
              setError("");
              setSaved(false);
              void save({ ...value, url: value.url.trim() })
                .then(() => setSaved(true))
                .catch(() =>
                  setError(
                    "ui.couldNotSaveProxySettingsCheckTheProxyAddressAndType",
                  ),
                )
                .finally(() => setWorking(false));
            }}
          >
            {t("ui.saveProxy")}
          </button>
          {saved && (
            <p role="status">
              {t(
                "ui.proxySettingsSavedTheyApplyToSubsequentRequests",
              )}
            </p>
          )}
        </>
      )}
      {error && <p role="alert">{t(error)}</p>}
    </section>
  );
}

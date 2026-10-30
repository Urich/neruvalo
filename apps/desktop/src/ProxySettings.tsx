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
        if (active) setError("Не удалось загрузить настройки прокси.");
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
      <h2>{t("Прокси")}</h2>
      <p className="muted">
        {t(
          "Настройки сохраняются только на этом устройстве и не отправляются серверу.",
        )}
      </p>
      {value && (
        <>
          <label>
            {t("Подключение к серверу")}
            <select
              value={value.mode}
              disabled={working || disabled}
              onChange={(e) => change({ ...value, mode: e.target.value })}
            >
              <option value="system">{t("Автоматически")}</option>
              <option value="direct">{t("Без прокси")}</option>
              <option value="manual">{t("Указать прокси")}</option>
            </select>
          </label>
          {value.mode === "manual" && (
            <>
              <label>
                {t("Адрес прокси")}
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
                    {t("Логин прокси")}
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
                    {t("Пароль прокси")}
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
                      "В Windows настройки и пароль прокси защищены DPAPI текущего пользователя.",
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
                    "Не удалось сохранить настройки прокси. Проверьте адрес и тип прокси.",
                  ),
                )
                .finally(() => setWorking(false));
            }}
          >
            {t("Сохранить прокси")}
          </button>
          {saved && (
            <p role="status">
              {t(
                "Настройки прокси сохранены. Они применятся к следующим запросам.",
              )}
            </p>
          )}
        </>
      )}
      {error && <p role="alert">{t(error)}</p>}
    </section>
  );
}

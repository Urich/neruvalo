import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import license from "./licenses/AGPL-3.0.txt?raw";
import components from "./licenses/components.json";
import { version } from "../package.json";
import { useI18n } from "./i18n";
type Component = {
  name: string;
  version: string;
  license: string;
  source: string;
  texts: { name: string; text: string }[];
};
export function About() {
  const { t } = useI18n();
  const [platform, setPlatform] = useState<{ os: string; arch: string } | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const commit = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "";
  const dirty = typeof __BUILD_DIRTY__ === "boolean" && __BUILD_DIRTY__;
  const source =
    "https://github.com/Urich/neruvalo" + (commit ? "/tree/" + commit : "");
  const link = (target: string) => {
    void invoke("command", {
      request: { action: "open_project_link", target, commit },
    });
  };
  useEffect(() => {
    let active = true;
    invoke<{ os: string; arch: string }>("command", {
      request: { action: "about" },
    })
      .then((p) => {
        if (active && p?.os) setPlatform(p);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return (
    <section className="detail-panel about-panel">
      <h1>Neruvalo</h1>
      <p>
        {t("О программе")} · {version}
      </p>
      <p>{t("Прототип. Не сохраняйте настоящие секреты.")}</p>
      <p>
        {t(
          "Менеджер паролей и секретов с открытым исходным кодом и собственным сервером.",
        )}
      </p>
      <dl>
        <dt>{t("Сборка")}</dt>
        <dd>
          <code>{commit.slice(0, 12)}</code>
          {dirty ? " + local changes" : ""}
          {platform && ` · ${platform.os} / ${platform.arch}`}
        </dd>
        <dt>{t("Совместимость")}</dt>
        <dd>
          {t("Протокол")}: 1 · {t("Формат записей")}: 1 · {t("Формат групп")}: 2
        </dd>
      </dl>
      <p>Urich &amp; contributors · AGPL-3.0-only</p>
      <p>
        {t(
          "Разрешены использование, изменение и распространение по условиям AGPL-3.0-only. Программа предоставляется без гарантий в пределах лицензии.",
        )}
      </p>
      <p>
        {t("Исходный код")}:{" "}
        <a
          href={source}
          onClick={(e) => {
            e.preventDefault();
            link("source");
          }}
        >
          {source}
        </a>
      </p>
      <p>
        <button className="subtle" onClick={() => link("issues")}>
          {t("Сообщить об ошибке")}
        </button>{" "}
        ·{" "}
        <button className="subtle" onClick={() => link("security")}>
          {t("Сообщить об уязвимости")}
        </button>
      </p>
      <p>
        {t(
          "Управляемый сервер предоставляется как отдельная платная услуга. Самостоятельное размещение доступно по лицензии проекта.",
        )}
      </p>
      <details>
        <summary>GNU Affero General Public License v3.0</summary>
        <pre className="about-license">{license}</pre>
      </details>
      <details>
        <summary>
          {t("Сторонние компоненты")} ({components.length})
        </summary>
        <p>
          {t(
            "Включая инструменты сборки и зависимости поддерживаемых платформ.",
          )}
        </p>
        <input
          aria-label={t("Поиск компонентов")}
          placeholder={t("Поиск компонентов")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {(components as Component[])
          .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
          .map((c, i) => (
            <details key={c.name + c.version + i}>
              <summary>
                {c.name} {c.version} · {c.license}
              </summary>
              <p>{c.source}</p>
              {c.texts.map((file) => (
                <div key={file.name}>
                  <h4>{file.name}</h4>
                  <pre className="about-license">{file.text}</pre>
                </div>
              ))}
            </details>
          ))}
      </details>
    </section>
  );
}

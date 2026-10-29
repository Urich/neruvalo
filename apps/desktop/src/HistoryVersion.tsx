import { useState } from "react";
import { Entry } from "./model";
import { fieldsOf } from "./documents";
import { useI18n } from "./i18n";
export function HistoryVersion({
  entry,
  disabled,
  onRestore,
}: {
  entry: Entry;
  disabled: boolean;
  onRestore: () => void;
}) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const fields = fieldsOf(entry.data);
  return (
    <details className="history-version">
      <summary>
        {t("Версия")} {entry.revision} · {entry.data.title}
        {entry.archived ? t(" · в архиве") : ""}
      </summary>
      {fields.map(([key, label, secret]) => {
        const value = entry.data.fields[key];
        if (!value) return null;
        return (
          <div className="field" key={key}>
            <small>{key.startsWith("custom:") ? label : t(label)}</small>
            <div>
              <code>{secret && !revealed[key] ? "••••••••••••" : value}</code>
              {secret && (
                <button
                  className="subtle"
                  type="button"
                  onClick={() =>
                    setRevealed({ ...revealed, [key]: !revealed[key] })
                  }
                >
                  {revealed[key] ? t("Скрыть") : t("Показать")}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {entry.data.notes && (
        <div className="field">
          <small>{t("Заметки")}</small>
          <p className="pre">{entry.data.notes}</p>
        </div>
      )}
      {entry.data.folder && (
        <p className="pre">
          {t("Папка:")} <bdi>{entry.data.folder}</bdi>
        </p>
      )}
      <div className="tags">
        {entry.data.tags.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
      <button
        className="secondary"
        type="button"
        disabled={disabled}
        onClick={onRestore}
      >
        {t("Восстановить новой версией")}
      </button>
    </details>
  );
}

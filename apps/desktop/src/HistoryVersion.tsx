import { useState } from "react";
import { Entry, types } from "./model";

export function HistoryVersion({
  entry,
  disabled,
  onRestore,
}: {
  entry: Entry;
  disabled: boolean;
  onRestore: () => void;
}) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const fields = types[entry.data.record_type]?.fields ?? [];
  return (
    <details className="history-version">
      <summary>
        Версия {entry.revision} · {entry.data.title}
        {entry.archived ? " · в архиве" : ""}
      </summary>
      {fields.map(([key, label, secret]) => {
        const value = entry.data.fields[key];
        if (!value) return null;
        return (
          <div className="field" key={key}>
            <small>{label}</small>
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
                  {revealed[key] ? "Скрыть" : "Показать"}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {entry.data.notes && (
        <div className="field">
          <small>Заметки</small>
          <p className="pre">{entry.data.notes}</p>
        </div>
      )}
      {entry.data.folder && <p className="pre">Папка: {entry.data.folder}</p>}
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
        Восстановить новой версией
      </button>
    </details>
  );
}

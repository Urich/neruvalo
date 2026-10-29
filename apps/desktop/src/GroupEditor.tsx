import { Group, groupLabel } from "./groups";
import { useI18n } from "./i18n";
export type GroupDraft = { title: string; parent: string | null };
export function GroupEditor({
  draft,
  groups,
  onChange,
  onSave,
  onCancel,
  disabled,
}: {
  draft: GroupDraft;
  groups: Group[];
  onChange: (draft: GroupDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="detail-heading">
        <h2>{t("Новая группа")}</h2>
        <button className="subtle" onClick={onCancel}>
          {t("Отмена")}
        </button>
      </div>
      <label>
        {t("Название группы")}
        <input
          autoFocus
          value={draft.title}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
        />
      </label>
      <label>
        {t("Родительская группа")}
        <select
          value={draft.parent ?? ""}
          onChange={(e) =>
            onChange({ ...draft, parent: e.target.value || null })
          }
        >
          <option value="">{t("Корень списка")}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {groupLabel(g.id, groups)}
            </option>
          ))}
        </select>
      </label>
      <button
        className="primary full"
        disabled={disabled || !draft.title.trim()}
        onClick={onSave}
      >
        {t("Создать группу")}
      </button>
    </>
  );
}

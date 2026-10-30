import { useEffect, useRef } from "react";
import { useI18n } from "./i18n";
export function ArchiveDialog({
  request,
  counts,
  onCancel,
  onConfirm,
}: {
  request: { title: string; archived: boolean };
  counts: { records: number; groups: number; unchanged: number };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const focus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="discard-dialog"
      aria-labelledby="archive-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 id="archive-title">
        {t(request.archived ? "В архив" : "Вернуть из архива")}
      </h2>
      <p>
        <bdi>{request.title}</bdi>
      </p>
      <p>
        {t("Записи")}: {counts.records} · {t("Группы")}: {counts.groups}
      </p>
      <p>
        {t("Без изменений")}: {counts.unchanged}
      </p>
      <p>
        {t(
          request.archived
            ? "Архивируется всё содержимое группы, включая скрытое фильтром."
            : "Восстанавливается выбранный элемент или всё поддерево группы, а также необходимые группы-предки.",
        )}
      </p>
      <div className="discard-actions">
        <button autoFocus className="secondary" onClick={onCancel}>
          {t("Отмена")}
        </button>
        <button className="primary" onClick={onConfirm}>
          {t("Продолжить")}
        </button>
      </div>
    </dialog>
  );
}

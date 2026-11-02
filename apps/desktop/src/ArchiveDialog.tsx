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
        {t(request.archived ? "ui.archiveEntry" : "ui.restoreFromArchive")}
      </h2>
      <p>
        <bdi>{request.title}</bdi>
      </p>
      <p>
        {t("ui.entries")}: {counts.records} · {t("ui.groups")}: {counts.groups}
      </p>
      <p>
        {t("ui.unchanged")}: {counts.unchanged}
      </p>
      <p>
        {t(
          request.archived
            ? "ui.allGroupContentsAreArchivedIncludingItemsHiddenByFilters"
            : "ui.restoreTheSelectedItemOrTheEntireGroupSubtreeTogetherWithRequiredAncestorGroups",
        )}
      </p>
      <div className="discard-actions">
        <button autoFocus className="secondary" onClick={onCancel}>
          {t("ui.cancel")}
        </button>
        <button className="primary" onClick={onConfirm}>
          {t("ui.continue")}
        </button>
      </div>
    </dialog>
  );
}

import { useEffect, useRef } from "react";
import { useI18n } from "./i18n";

export function ConfirmNewEntry({
  onCancel,
  onConfirm,
  general = false,
}: {
  general?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="discard-dialog"
      aria-labelledby="discard-title"
      aria-describedby="discard-description"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="discard-title">
        {t(general ? "ui.discardChanges" : "ui.startANewEntry")}
      </h2>
      <p id="discard-description">
        {t("ui.unsavedChangesToThisEntryWillBeLost")}
      </p>
      <div className="discard-actions">
        <button
          type="button"
          className="secondary"
          autoFocus
          onClick={onCancel}
        >
          {t("ui.keepEditing")}
        </button>
        <button type="button" className="primary" onClick={onConfirm}>
          {t(general ? "ui.continue" : "ui.startNewEntry")}
        </button>
      </div>
    </dialog>
  );
}

import { useEffect, useRef } from "react";
import { useI18n } from "./i18n";
export function DismissShare({
  title,
  onCancel,
  onConfirm,
}: {
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="discard-dialog"
      aria-labelledby="dismiss-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 id="dismiss-title">{t("ui.removeForMe")}</h2>
      <p>
        <bdi>{title}</bdi>
      </p>
      <p>
        {t(
          "ui.onlyYourAccessWillEndTheOriginalAndOtherUsersCopiesRemain",
        )}
      </p>
      <div className="discard-actions">
        <button autoFocus className="secondary" onClick={onCancel}>
          {t("ui.cancel")}
        </button>
        <button className="primary" onClick={onConfirm}>
          {t("ui.confirm")}
        </button>
      </div>
    </dialog>
  );
}

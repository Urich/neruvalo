import { useEffect, useRef } from "react";

export function ConfirmNewEntry({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
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
      <h2 id="discard-title">Начать новую запись?</h2>
      <p id="discard-description">
        Несохранённые изменения в текущей записи будут потеряны.
      </p>
      <div className="discard-actions">
        <button
          type="button"
          className="secondary"
          autoFocus
          onClick={onCancel}
        >
          Продолжить редактирование
        </button>
        <button type="button" className="primary" onClick={onConfirm}>
          Начать новую запись
        </button>
      </div>
    </dialog>
  );
}

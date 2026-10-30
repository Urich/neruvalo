import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";
import { errorText } from "./model";
export type Recipient = {
  id: string;
  login: string;
  public_sign: string;
  public_share: string;
  fingerprint?: string;
};
export function ShareDialog({
  title,
  wallet,
  recipients,
  onResolve,
  onCreate,
  onRevoke,
  onClose,
  disabled,
}: {
  title: string;
  wallet: boolean;
  recipients: { share_id: string; recipient_login: string }[];
  onResolve: (login: string) => Promise<Recipient>;
  onCreate: (login: string) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  onClose: () => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const [login, setLogin] = useState("");
  const [target, setTarget] = useState<Recipient | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const d = ref.current!;
    const previous = document.activeElement;
    d.showModal();
    return () => {
      d.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  async function run(fn: () => Promise<void>) {
    setWorking(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(t(errorText(e)));
    } finally {
      setWorking(false);
    }
  }
  return (
    <dialog
      ref={ref}
      className="discard-dialog share-dialog"
      aria-labelledby="share-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!working) onClose();
      }}
    >
      <h2 id="share-title">{t("Поделиться")}</h2>
      <p>
        <bdi>{title}</bdi>
      </p>
      <p>
        {t(
          "Получатель увидит все поля и заметки. Ваши группы и теги не передаются.",
        )}
      </p>
      {wallet && (
        <p role="alert">
          {t(
            "Seed-фраза и приватные ключи позволяют управлять средствами кошелька.",
          )}
        </p>
      )}
      <label>
        {t("Логин получателя")}
        <input
          value={login}
          disabled={working || disabled}
          autoComplete="off"
          onChange={(e) => {
            setLogin(e.target.value);
            setTarget(null);
          }}
        />
      </label>
      <button
        className="secondary"
        disabled={working || disabled || !login.trim()}
        onClick={() => {
          void run(async () => setTarget(await onResolve(login.trim())));
        }}
      >
        {t("Проверить получателя")}
      </button>
      {target && (
        <div className="share-recipient">
          <p>
            <bdi>{target.login}</bdi> · <code>{target.id}</code>
          </p>
          <p>
            <code>{target.fingerprint}</code>
          </p>
          <p>{t("Публичные ключи получателя")}:</p>
          <code>{target.public_sign}</code>
          <br />
          <code>{target.public_share}</code>
          <p>
            {t(
              "Сверьте ключи с получателем по независимому каналу при необходимости.",
            )}
          </p>
          <button
            className="primary"
            disabled={working || disabled}
            onClick={() => {
              void run(async () => {
                await onCreate(target.login);
                setTarget(null);
                setLogin("");
              });
            }}
          >
            {t("Подтвердить передачу")}
          </button>
        </div>
      )}
      <h3>{t("Действующие получатели")}</h3>
      {recipients.map((r) => (
        <div className="share-recipient" key={r.share_id}>
          <bdi>{r.recipient_login}</bdi>
          <button
            className="secondary"
            disabled={working || disabled}
            onClick={() => {
              void run(() => onRevoke(r.share_id));
            }}
          >
            {t("Отозвать доступ")}
          </button>
        </div>
      ))}
      {!recipients.length && <p>{t("Доступ пока никому не предоставлен.")}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="discard-actions">
        <button className="secondary" disabled={working} onClick={onClose}>
          {t("Закрыть")}
        </button>
      </div>
    </dialog>
  );
}

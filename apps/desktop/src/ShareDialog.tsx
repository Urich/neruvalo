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
      setError(errorText(e));
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
      <h2 id="share-title">{t("ui.share")}</h2>
      <p>
        <bdi>{title}</bdi>
      </p>
      <p>
        {t(
          "ui.theRecipientWillSeeAllFieldsAndNotesYourGroupsAndTagsAreExcluded",
        )}
      </p>
      {wallet && (
        <p role="alert">
          {t(
            "ui.seedPhrasesAndPrivateKeysGiveControlOverWalletFunds",
          )}
        </p>
      )}
      <label>
        {t("ui.recipientLogin")}
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
        {t("ui.verifyRecipient")}
      </button>
      {target && (
        <div className="share-recipient">
          <p>
            <bdi>{target.login}</bdi> · <code>{target.id}</code>
          </p>
          <p>
            <code>{target.fingerprint}</code>
          </p>
          <p>{t("ui.recipientPublicKeys")}:</p>
          <code>{target.public_sign}</code>
          <br />
          <code>{target.public_share}</code>
          <p>
            {t(
              "ui.compareKeysWithTheRecipientThroughAnIndependentChannelIfNeeded",
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
            {t("ui.confirmSharing")}
          </button>
        </div>
      )}
      <h3>{t("ui.activeRecipients")}</h3>
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
            {t("ui.revokeAccess")}
          </button>
        </div>
      ))}
      {!recipients.length && <p>{t("ui.noOneHasAccessYet")}</p>}
      {error && <p role="alert">{t(error)}</p>}
      <div className="discard-actions">
        <button className="secondary" disabled={working} onClick={onClose}>
          {t("ui.close")}
        </button>
      </div>
    </dialog>
  );
}

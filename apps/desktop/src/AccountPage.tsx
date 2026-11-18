import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ContactScanner } from "./ContactScanner";
import { useI18n } from "./i18n";
import { Entry, errorText } from "./model";
import type { VerifiedContact } from "./ShareDialog";

type AccountContact = { account_id: string; fingerprint: string; qr: string };
type ContactSelection =
  | { kind: "idle" | "scanning" | "checking" }
  | { kind: "failed"; message: string }
  | { kind: "verified"; contact: VerifiedContact };

export function AccountPage({
  profile,
  login,
  server,
  canShare,
  records,
  resolveContact,
  onShare,
}: {
  profile: string;
  login: string;
  server: string;
  canShare: boolean;
  records: Entry[];
  resolveContact: (code: string) => Promise<VerifiedContact["recipient"]>;
  onShare: (entry: Entry, contact: VerifiedContact) => void;
}) {
  const { t } = useI18n();
  const [account, setAccount] = useState<AccountContact | null>(null);
  const [accountError, setAccountError] = useState("");
  const [showQrHelp, setShowQrHelp] = useState(false);
  const qrHelpButton = useRef<HTMLButtonElement>(null);
  const [selection, setSelection] = useState<ContactSelection>({ kind: "idle" });
  const [recordId, setRecordId] = useState("");
  const shareable = records.filter(
    (record) => !record.archived && !record.received && record.data.record_type !== "group",
  );
  const selected = shareable.find((record) => record.record_id === recordId);
  const scanning = selection.kind === "scanning";
  const checking = selection.kind === "checking";
  const contact = selection.kind === "verified" ? selection.contact : null;

  useEffect(() => {
    let active = true;
    invoke<AccountContact>("command", {
      request: { action: "account_contact", expected_profile: profile },
    })
      .then((result) => {
        if (active) setAccount(result);
      })
      .catch((error) => {
        if (active) setAccountError(errorText(error));
      });
    return () => { active = false; };
  }, [profile]);
  useEffect(() => {
    if (!canShare && scanning) setSelection({ kind: "idle" });
  }, [canShare, scanning]);

  async function scanned(code: string) {
    setSelection({ kind: "checking" });
    try {
      const recipient = await resolveContact(code);
      setSelection({ kind: "verified", contact: { code, recipient } });
    } catch (error) {
      setSelection({ kind: "failed", message: errorText(error) });
    }
  }

  function closeQrHelp() {
    setShowQrHelp(false);
    qrHelpButton.current?.focus();
  }

  return (
    <section className="account-page" aria-labelledby="account-heading">
      <div className="account-heading">
        <h1 id="account-heading">{t("ui.accountPage")}</h1>
        {account && (
          <button
            ref={qrHelpButton}
            type="button"
            className="secondary account-qr-help-button"
            aria-label={t("ui.accountContactQr")}
            aria-expanded={showQrHelp}
            aria-controls={showQrHelp ? "account-qr-help" : undefined}
            onClick={() => setShowQrHelp(!showQrHelp)}
          >
            ?
          </button>
        )}
      </div>
      <dl className="account-details">
        <dt>{t("ui.username")}</dt>
        <dd><bdi>{login}</bdi></dd>
        <dt>{t("ui.server")}</dt>
        <dd><bdi>{server}</bdi></dd>
        {account && (
          <>
            <dt>{t("ui.accountId")}</dt>
            <dd><code>{account.account_id}</code></dd>
            <dt>{t("ui.accountFingerprint")}</dt>
            <dd><code>{account.fingerprint}</code></dd>
          </>
        )}
      </dl>
      {accountError && <p role="alert">{t(accountError)}</p>}
      {account && (
        <section aria-labelledby="account-contact-heading">
          <h2 id="account-contact-heading">{t("ui.accountContactQr")}</h2>
          {showQrHelp && (
            <aside
              id="account-qr-help"
              className="account-qr-help"
              role="dialog"
              aria-labelledby="account-contact-heading"
              aria-describedby="account-qr-help-text"
              onKeyDown={(event) => {
                if (event.key === "Escape") closeQrHelp();
              }}
            >
              <p id="account-qr-help-text">{t("ui.accountContactHint")}</p>
              <button type="button" className="secondary" autoFocus onClick={closeQrHelp}>
                {t("ui.close")}
              </button>
            </aside>
          )}
          <img className="account-qr" src={account.qr} alt={t("ui.accountContactQr")} />
        </section>
      )}
      <button
        type="button"
        className="secondary"
        disabled={!canShare || scanning || checking}
        onClick={() => {
          setRecordId("");
          setSelection({ kind: "scanning" });
        }}
      >
        {t("ui.scanShareContact")}
      </button>
      {scanning && canShare && (
        <ContactScanner
          onScan={(code) => void scanned(code)}
          onClose={() => setSelection({ kind: "idle" })}
        />
      )}
      {checking && <p role="status">{t("ui.verificationChecking")}</p>}
      {selection.kind === "failed" && <p role="alert">{t(selection.message)}</p>}
      {contact && (
        <div className="share-recipient">
          <p>{t("ui.recipientLogin")}: <bdi>{contact.recipient.login}</bdi></p>
          {shareable.length ? (
            <label>
              {t("ui.selectRecordToShare")}
              <select value={recordId} disabled={!canShare} onChange={(event) => setRecordId(event.target.value)}>
                <option value="">{t("ui.selectRecordToShare")}</option>
                {shareable.map((entry) => (
                  <option key={entry.record_id} value={entry.record_id}>
                    {[entry.data.folder, entry.data.title].filter(Boolean).join(" / ")}
                  </option>
                ))}
              </select>
            </label>
          ) : <p>{t("ui.noRecordsToShare")}</p>}
          <button
            type="button"
            className="primary"
            disabled={!canShare || !selected}
            onClick={() => {
              if (selected) onShare(selected, contact);
            }}
          >
            {t("ui.share")}
          </button>
        </div>
      )}
    </section>
  );
}

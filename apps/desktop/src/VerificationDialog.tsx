import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useI18n } from "./i18n";
import { Icon } from "./Icon";

type Attempt = { id: string; url: string };

export function VerificationDialog() {
  const { t, language } = useI18n();
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [error, setError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const subscriptions = [
      listen<Attempt>("verification-open", ({ payload }) => {
        if (!URL.canParse(payload.url)) return;
        const url = new URL(payload.url);
        if (url.pathname !== "/verification" || url.username || url.password ||
          !(url.protocol === "https:" || (url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) return;
        setError(false);
        setAttempt(payload);
      }),
      listen<string>("verification-close", ({ payload }) => {
        setAttempt((current) => current?.id === payload ? null : current);
      }),
    ];
    return () => { subscriptions.forEach((subscription) => { void subscription.then((off) => off()); }); };
  }, []);

  useEffect(() => {
    if (!attempt) return;
    const previous = document.activeElement;
    const modal = dialog.current!;
    modal.showModal();
    return () => {
      modal.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [attempt]);

  if (!attempt) return null;
  const url = new URL(attempt.url);
  url.searchParams.set("embedded", "1");
  url.searchParams.set("lang", language);
  const cancel = async () => {
    try {
      await invoke("cancel_verification", { id: attempt.id });
      setAttempt((current) => current?.id === attempt.id ? null : current);
    } catch { setError(true); }
  };
  return (
    <dialog ref={dialog} className="discard-dialog verification-dialog"
      aria-labelledby="verification-title" aria-describedby="verification-description"
      onCancel={(event) => { event.preventDefault(); void cancel(); }}>
      <header className="verification-header">
        <span className="verification-mark"><Icon name="login" /></span>
        <div>
          <h2 id="verification-title">{t("ui.verifyIdentity")}</h2>
          <p id="verification-description">{t("ui.completeVerificationToContinue")}</p>
        </div>
      </header>
      <iframe src={url.href} title={t("ui.verifyIdentity")}
        sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />
      {error && <p role="alert">{t("ui.operationFailedCheckYourConnectionAndTryAgain")}</p>}
      <footer className="verification-footer">
        <span>{t("ui.verificationContinuesAutomatically")}</span>
        <button type="button" className="secondary" onClick={() => void cancel()}>{t("ui.cancel")}</button>
      </footer>
    </dialog>
  );
}

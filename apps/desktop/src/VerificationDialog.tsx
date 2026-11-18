import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useI18n } from "./i18n";
import { Icon } from "./Icon";

type Attempt = { id: string; url: string };

export function VerificationDialog({ inlineTarget }: { inlineTarget?: HTMLElement | null }) {
  const { t, language } = useI18n();
  const [attempt, setAttempt] = useState<(Attempt & { theme: string }) | null>(null);
  const [error, setError] = useState(false);
  const [visual, setVisual] = useState(false);
  const inline = inlineTarget !== undefined;
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const subscriptions = [
      listen<Attempt>("verification-open", ({ payload }) => {
        if (!URL.canParse(payload.url)) return;
        const url = new URL(payload.url);
        if (url.pathname !== "/verification" || url.username || url.password ||
          !(url.protocol === "https:" || (url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) return;
        setError(false);
        setVisual(false);
        setAttempt({ ...payload, theme: document.documentElement.dataset.theme || "light" });
      }),
      listen<string>("verification-close", ({ payload }) => {
        setAttempt((current) => current?.id === payload ? null : current);
      }),
    ];
    return () => { subscriptions.forEach((subscription) => { void subscription.then((off) => off()); }); };
  }, []);

  useEffect(() => {
    if (!attempt || inline) return;
    const previous = document.activeElement;
    const modal = dialog.current!;
    modal.showModal();
    return () => {
      modal.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [attempt, inline]);

  useEffect(() => {
    if (!attempt || !inline) return;
    const origin = new URL(attempt.url).origin;
    function onMessage(event: MessageEvent) {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow ||
          event.data?.type !== "neruvalo-verification") return;
      if (event.data.state === "visual") setVisual(true);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [attempt, inline]);

  if (!attempt) return null;
  const url = new URL(attempt.url);
  url.searchParams.set("embedded", "1");
  url.searchParams.set("lang", language);
  url.searchParams.set("theme", attempt.theme);
  if (inline) url.searchParams.set("inline", "1");
  const cancel = async () => {
    try {
      await invoke("cancel_verification", { id: attempt.id });
      setAttempt((current) => current?.id === attempt.id ? null : current);
    } catch { setError(true); }
  };
  const content = (
    <>
      <iframe key={attempt.id} ref={frame} src={url.href} title={t("ui.verifyIdentity")}
        sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />
      {error && <p role="alert">{t("ui.operationFailedCheckYourConnectionAndTryAgain")}</p>}
      <footer className="verification-footer">
        {!inline && <span>{t("ui.verificationContinuesAutomatically")}</span>}
        <button type="button" className="secondary" onClick={() => void cancel()}>{t("ui.cancel")}</button>
      </footer>
    </>
  );
  if (inline) {
    if (!inlineTarget) return null;
    return createPortal(
      <section
        className={visual ? "registration-verification registration-verification-visual" : "registration-verification"}
        aria-labelledby="verification-title"
      >
        <h3 id="verification-title">{t("ui.verificationPrompt")}</h3>
        {content}
      </section>,
      inlineTarget,
    );
  }
  return (
    <dialog ref={dialog} className="discard-dialog verification-dialog"
      aria-labelledby="verification-title"
      onCancel={(event) => { event.preventDefault(); void cancel(); }}>
      <header className="verification-header">
        <span className="verification-mark"><Icon name="login" /></span>
        <div>
          <h2 id="verification-title">{t("ui.verificationPrompt")}</h2>
        </div>
      </header>
      {content}
    </dialog>
  );
}

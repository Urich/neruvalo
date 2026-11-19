import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useI18n } from "./i18n";

type Attempt = { id: string; url: string };
type VerificationPhase = "checkbox" | "checking" | "visual" | "verified";

export function VerificationFrame({ target }: { target: HTMLElement | null }) {
  const { t, language } = useI18n();
  const [attempt, setAttempt] = useState<(Attempt & { theme: string }) | null>(null);
  const [error, setError] = useState(false);
  const [phase, setPhase] = useState<VerificationPhase>("checkbox");
  const frame = useRef<HTMLIFrameElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useCallback(async (id: string) => {
    try {
      await invoke("cancel_verification", { id });
      setAttempt((current) => current?.id === id ? null : current);
    } catch { setError(true); }
  }, []);

  useEffect(() => {
    const subscriptions = [
      listen<Attempt>("verification-open", ({ payload }) => {
        if (!URL.canParse(payload.url)) return;
        const url = new URL(payload.url);
        if (url.pathname !== "/verification" || url.username || url.password ||
          !(url.protocol === "https:" || (url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) return;
        setError(false);
        setPhase("checkbox");
        setAttempt({ ...payload, theme: document.documentElement.dataset.theme || "light" });
      }),
      listen<string>("verification-close", ({ payload }) => {
        setAttempt((current) => current?.id === payload ? null : current);
      }),
    ];
    return () => { subscriptions.forEach((subscription) => { void subscription.then((off) => off()); }); };
  }, []);

  useEffect(() => {
    if (!attempt) return;
    const { id, url } = attempt;
    const origin = new URL(url).origin;
    function onMessage(event: MessageEvent) {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow ||
          event.data?.type !== "neruvalo-verification") return;
      const { state } = event.data;
      if (state === "checking" || state === "visual" || state === "verified") setPhase(state);
      if (state === "error") setPhase((current) => current === "visual" ? "visual" : "checkbox");
      if (state === "cancel") void cancel(id);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [attempt, cancel]);

  useLayoutEffect(() => {
    const container = dialog.current;
    if (!container) return;
    if (phase === "visual") container.showModal();
    else if (phase === "checkbox") container.open = true;
    return () => {
      if (container.open) container.close();
    };
  }, [attempt, phase, target]);

  if (!attempt || !target) return null;
  const url = new URL(attempt.url);
  url.searchParams.set("embedded", "1");
  url.searchParams.set("inline", "1");
  url.searchParams.set("lang", language);
  url.searchParams.set("theme", attempt.theme);
  const visual = phase === "visual";
  const checking = phase === "checking" || phase === "verified";
  const cancellationError = error && <p role="alert">{t("ui.operationFailedCheckYourConnectionAndTryAgain")}</p>;
  return createPortal(
    <section className="auth-verification" aria-label={t("ui.verifyIdentity")}>
      <dialog ref={dialog} className={visual ? "discard-dialog verification-dialog" : "verification-inline"}
        aria-label={t("ui.verifyIdentity")}
        onCancel={(event) => { event.preventDefault(); void cancel(attempt.id); }}>
        <iframe key={attempt.id} ref={frame} src={url.href} title={t("ui.verifyIdentity")}
          sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" hidden={checking} />
        {visual && (
          <div className="verification-dialog-actions">
            <button type="button" className="secondary" onClick={() => void cancel(attempt.id)}>{t("ui.cancel")}</button>
          </div>
        )}
        {visual && cancellationError}
      </dialog>
      <div className="verification-progress" role="status">
        {checking && (
          <>
            <span className="loading-spinner" aria-hidden="true" />
            {t("ui.verificationChecking")}
          </>
        )}
      </div>
      {!visual && cancellationError}
    </section>,
    target,
  );
}

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "./i18n";

type Prepared = { enabled: boolean; secret?: string; url?: string };
export function VerificationInline({ server, login, email, kind, onReady }: {
  server: string; login: string; email: string; kind: "login" | "register";
  onReady: (secret: string | null) => void;
}) {
  const { t, language } = useI18n();
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState(false);
  const [visual, setVisual] = useState(false);
  const [revision, setRevision] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const ready = useRef(onReady);
  ready.current = onReady;

  useEffect(() => {
    let active = true;
    let expiry: ReturnType<typeof setTimeout>;
    setPrepared(null); setError(false); setVisual(false); ready.current(null);
    if (!URL.canParse(server) || !login || (kind === "register" && !email)) return;
    const timer = setTimeout(() => {
      void invoke<Prepared>("command", {request: {action: "prepare_verification", server, login, email, kind}})
        .then((result) => {
          if (!active) return;
          if (!result || (result.enabled && (!result.url || !result.secret))) throw Error("Invalid verification");
          setPrepared(result);
          if (!result.enabled) ready.current("");
          else expiry = setTimeout(() => {
            ready.current(null); setPrepared(null); setRevision((value) => value + 1);
          }, 165000);
        }).catch(() => { if (active) setError(true); });
    }, 400);
    return () => { active = false; clearTimeout(timer); clearTimeout(expiry); };
  }, [server, login, email, kind, revision, language]);

  useEffect(() => {
    if (!prepared?.url) return;
    const origin = new URL(prepared.url).origin;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin ||
        event.data?.type !== "neruvalo-verification") return;
      if (event.data.state === "visual") setVisual(true);
      if (event.data.state === "verified") { ready.current(prepared.secret!); setVisual(false); }
      if (event.data.state === "error") { ready.current(null); setError(true); }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [prepared]);

  useEffect(() => {
    const modal = dialog.current;
    if (!modal) return;
    modal.close();
    if (visual) modal.showModal(); else modal.open = true;
    return () => modal.close();
  }, [prepared, visual]);

  if (prepared && !prepared.enabled) return null;
  const url = prepared?.url ? new URL(prepared.url) : null;
  if (url) {
    url.searchParams.set("embedded", "1"); url.searchParams.set("inline", "1");
    url.searchParams.set("lang", language);
  }
  const retry = () => { ready.current(null); setRevision((value) => value + 1); };
  return <div className="verification-inline">
    {url ? <dialog ref={dialog} className={visual ? "discard-dialog verification-dialog verification-visual" : "verification-checkbox"}
      aria-label={t("ui.verifyIdentity")}
      onCancel={(event) => { event.preventDefault(); retry(); }}>
      <iframe ref={frame} src={url.href} title={t("ui.verifyIdentity")}
        sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />
      {visual && <button type="button" className="secondary" onClick={retry}>{t("ui.cancel")}</button>}
    </dialog> : <p role="status">{t("ui.completeVerificationToContinue")}</p>}
    {error && <div role="alert">{t("ui.operationFailedCheckYourConnectionAndTryAgain")}
      <button type="button" className="secondary" onClick={retry}>{t("ui.verifyIdentity")}</button>
    </div>}
  </div>;
}

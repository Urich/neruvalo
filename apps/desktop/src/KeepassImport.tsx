import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "./i18n";
import { errorText } from "./model";
import { reportLabelKeys } from "./importMessages";

export type KeepassReport = {
  ticket: string; folder: string; entries: number; groups: number; attachments: number;
  archived: number; history_versions: number; can_confirm: boolean; dispatched: boolean;
  completed?: boolean;
  issues: { code: string; item: string; blocking: boolean; group_path?: string[]; source_id?: string; field?: string }[];
};
export function KeepassImport({ profile, disabled, onChanged }: {
  profile: string; disabled: boolean; onChanged: () => Promise<void>;
}) {
  const { t, language } = useI18n();
  const [folder, setFolder] = useState("KeePass");
  const [password, setPassword] = useState("");
  const [keyfile, setKeyfile] = useState(false);
  const [report, setReport] = useState<KeepassReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function call<T>(action: string, args = {}) { return invoke<T>("command", { request: { action, expected_profile: profile, ...args } }); }
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const pending = await call<KeepassReport | null>("keepass_status");
        const value = pending ?? await call<KeepassReport | null>("keepass_last_report");
        if (active) setReport(value);
      } catch (e) { if (active) setError(errorText(e)); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [profile]);
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); setPassword(""); }
  }
  async function reset() {
    if (report && !report.completed) await call("keepass_cancel", { ticket: report.ticket });
    setReport(null); setPassword("");
  }
  const unavailable = disabled || busy || loading;
  return <section className="import-card" aria-labelledby="keepass-title">
    <h2 id="keepass-title">{t("ui.keepassImport")}</h2>
    {loading ? <p>{t("ui.pleaseWait")}</p> : !report ? <form onSubmit={(e) => {
      e.preventDefault(); void run(async () => {
        const value = await call<KeepassReport | null>("keepass_prepare", { folder, password, use_keyfile: keyfile });
        if (value) setReport(value);
      });
    }}>
      <p className="muted">{t("ui.keepassHelp")}</p>
      <label>{t("ui.keepassFolder")}<input value={folder} disabled={unavailable} required maxLength={256} onChange={(e) => setFolder(e.target.value)} /></label>
      <label>{t("ui.keepassPassword")}<input type="password" value={password} autoComplete="off" disabled={unavailable} onChange={(e) => setPassword(e.target.value)} /></label>
      <label className="import-keyfile"><input type="checkbox" checked={keyfile} disabled={unavailable} onChange={(e) => setKeyfile(e.target.checked)} />{t("ui.keepassKeyfile")}</label>
      <button type="submit" className="primary" disabled={unavailable || !folder.trim() || (!password && !keyfile)}>{t(busy ? "ui.pleaseWait" : "ui.keepassPreview")}</button>
    </form> : <div className="import-summary">
      <h3>{t(report.completed ? "ui.reportCompleted" : !report.can_confirm ? "ui.reportBlocked" : "ui.reportPreview")}</h3>
      <p><bdi>{report.folder}</bdi></p>
      <dl>
        {([
          ["keepassEntries", report.entries], ["keepassGroups", report.groups], ["attachments", report.attachments],
          ["keepassArchived", report.archived], ["keepassHistory", report.history_versions],
          ["reportRows", report.issues.length], ["reportErrors", report.issues.filter(i => i.blocking).length],
        ] as const).map(([key, value]) => <div key={key}><dt>{t(`ui.${key}`)}</dt><dd>{value}</dd></div>)}
      </dl>
      {!report.completed && <p className="muted">{t("ui.importReviewShort")}</p>}
      {report.dispatched && !report.completed && <p role="status">{t("ui.importUncertainShort")}</p>}
      <div className="import-actions">
        <button type="button" className="secondary" disabled={unavailable} onClick={() => void run(async () => {
          const keys = [...new Set([...reportLabelKeys, ...report.issues.map(issue => `keepassIssue.${issue.code}`)])];
          const labels = { ...Object.fromEntries(keys.map(key => [key, t(`ui.${key}`)])), language };
          await call("keepass_open_report", { ticket: report.ticket, labels });
        })}>{t("ui.openImportReport")}</button>
        {(!report.dispatched || report.completed) && <button type="button" className="secondary" disabled={unavailable}
          onClick={() => void run(reset)}>{t(report.completed ? "ui.newImport" : "ui.cancel")}</button>}
        {!report.completed && <button type="button" className="primary" disabled={unavailable || !report.can_confirm} onClick={() => void run(async () => {
          setReport({ ...report, dispatched: true });
          try { await call("keepass_commit", { ticket: report.ticket }); }
          catch (e) {
            const current = await call<KeepassReport | null>("keepass_status").catch(() => null);
            if (current) setReport(current);
            throw e;
          }
          setReport({ ...report, completed: true, dispatched: false });
          await onChanged();
        })}>{t(busy ? "ui.pleaseWait" : report.dispatched ? "ui.keepassRetry" : "ui.keepassConfirm")}</button>}
      </div>
    </div>}
    {error && <p role="alert" className="error">{t(error)}</p>}
  </section>;
}

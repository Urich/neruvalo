import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Entry, errorText } from "./model";
import { useI18n } from "./i18n";
import { SecretInput } from "./SecretInput";
type Config = {
    secret: string;
    issuer: string;
    account: string;
    algorithm: string;
    digits: number;
    period: number;
};
type Code = {
    code: string;
    generated_at: number;
    valid_until: number;
    period: number;
};
const isVisible = () => document.visibilityState !== "hidden";
const call = <T,>(profile: string | undefined, action: string, args = {}) => invoke<T>("command", { request: { action, expected_profile: profile, ...args } });
// Refresh from the native clock at period boundaries and when returning from
// the background. Never leave an expired token visible while awaiting IPC.
function useCode(fetchCode: () => Promise<Code>, identity: string) {
    const fetchRef = useRef(fetchCode);
    fetchRef.current = fetchCode;
    const [result, setResult] = useState<Code | null>(null);
    const [now, setNow] = useState(Date.now() / 1000);
    const [error, setError] = useState("");
    const retry = useRef(() => { });
    useEffect(() => {
        let active = true, pending = false, failed = false;
        let current: Code | null = null;
        let lastWall = Date.now(), lastMono = performance.now();
        const refresh = async () => {
            if (!active || pending || !isVisible())
                return;
            pending = true;
            failed = false;
            current = null;
            setResult(null);
            setError("");
            try {
                const next = await fetchRef.current();
                if (active && isVisible()) {
                    current = next;
                    setResult(next);
                    setNow(Date.now() / 1000);
                }
            }
            catch (e) {
                if (active) {
                    failed = true;
                    setError(errorText(e));
                }
            }
            finally {
                pending = false;
            }
        };
        retry.current = () => { void refresh(); };
        void refresh();
        const tick = () => {
            const wall = Date.now(), mono = performance.now();
            const jumped = Math.abs((wall - lastWall) - (mono - lastMono)) > 1500;
            lastWall = wall;
            lastMono = mono;
            setNow(wall / 1000);
            if (!isVisible())
                return;
            if (jumped || (!failed && (!current || wall / 1000 >= current.valid_until || wall / 1000 < current.valid_until - current.period)))
                void refresh();
        };
        const visibility = () => {
            current = null;
            setResult(null);
            if (isVisible())
                void refresh();
        };
        const timer = setInterval(tick, 250);
        document.addEventListener("visibilitychange", visibility);
        return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", visibility); current = null; };
    }, [identity]);
    const valid = result && now >= result.valid_until - result.period && now < result.valid_until;
    return { code: valid ? result : null, remaining: valid ? Math.max(0, Math.ceil(result.valid_until - now)) : 0, error, retry: () => retry.current() };
}
function Token({ state }: {
    state: ReturnType<typeof useCode>;
}) {
    const { t } = useI18n();
    return <div className="totp-token">
    <code aria-live="polite">{state.code ? state.code.code.replace(/(.{3})(?=.)/g, "$1 ") : "··· ···"}</code>
    {state.code && <><progress aria-label={t("ui.totpRemaining")} max={state.code.period} value={state.remaining}/><span>{t("ui.totpRemaining")}: {state.remaining} {t("ui.secondsShort")}</span></>}
    {state.error && <><p role="alert">{t(state.error)}</p><button type="button" className="secondary" onClick={state.retry}>{t("ui.totpRetry")}</button></>}
  </div>;
}
export function TotpDisplay({ entry, profile, clipboardSeconds, onCopied }: {
    entry: Entry;
    profile?: string;
    clipboardSeconds: number;
    onCopied?: () => void;
}) {
    const { t } = useI18n();
    const [qr, setQr] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const active = useRef(true);
    useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
    const args = { id: entry.record_id, expected_version: entry.version_id };
    const state = useCode(() => call<Code>(profile, "totp_code", args), `${profile}-${entry.record_id}-${entry.version_id}`);
    async function action(fn: () => Promise<void>) {
        setBusy(true);
        setError("");
        try {
            await fn();
        }
        catch (e) {
            if (active.current)
                setError(errorText(e));
        }
        finally {
            if (active.current)
                setBusy(false);
        }
    }
    return <section className="totp-panel" aria-label={t("ui.totpCode")}>
    <h3>{t("ui.totpCode")}</h3><Token state={state}/>
    <div className="totp-actions">
      <button type="button" className="secondary" disabled={busy || !state.code} onClick={() => void action(async () => { await call(profile, "copy_field", { ...args, field: "totp_code", seconds: clipboardSeconds }); if (active.current)
        onCopied?.(); state.retry(); })}>{t("ui.copy")}</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => qr ? setQr("") : void action(async () => {
            const image = await call<string>(profile, "totp_qr", args);
            if (active.current)
                setQr(image);
        })}>{t(qr ? "ui.hideQr" : "ui.showQr")}</button>
    </div>
    {qr && <img className="totp-qr" src={qr} alt={t("ui.totpQr")}/>}
    <details><summary>{t("ui.totpProvisioning")}</summary><label>{t("ui.totpSecretOrUri")}<SecretInput readOnly value={entry.data.fields.totp ?? ""}/></label></details>
    {error && <p role="alert">{t(error)}</p>}
  </section>;
}
function Preview({ config, profile }: {
    config: Config;
    profile?: string;
}) {
    const state = useCode(async () => (await call<{
        code: Code;
    }>(profile, "totp_preview", { config })).code, JSON.stringify(config));
    return <Token state={state}/>;
}
export function TotpEditor({ value, profile, onChange, onValidity }: {
    value: string;
    profile?: string;
    onChange: (uri: string) => void;
    onValidity: (valid: boolean) => void;
}) {
    const { t } = useI18n();
    const [config, setConfig] = useState<Config>({ secret: value, issuer: "", account: "", algorithm: "SHA1", digits: 6, period: 30 });
    const [valid, setValid] = useState<Config | null>(null);
    const [error, setError] = useState("");
    const [qr, setQr] = useState("");
    const [busy, setBusy] = useState(false);
    const dirty = useRef(false);
    const callbacks = useRef({ onChange, onValidity });
    callbacks.current = { onChange, onValidity };
    const alive = useRef(true);
    const qrSequence = useRef(0);
    useEffect(() => { alive.current = true; return () => { alive.current = false; qrSequence.current++; }; }, []);
    const change = (next: Config) => { dirty.current = true; qrSequence.current++; setQr(""); setConfig({ ...next }); setValid(null); callbacks.current.onValidity(false); };
    useEffect(() => {
        let active = true;
        setError("");
        setValid(null);
        if (!config.secret.trim()) {
            callbacks.current.onValidity(true);
            if (dirty.current)
                callbacks.current.onChange("");
            return;
        }
        callbacks.current.onValidity(false);
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    if (config.secret.startsWith("otpauth:")) {
                        const parsed = await call<{
                            config: Config;
                        }>(profile, "totp_parse", { value: config.secret });
                        if (active)
                            setConfig(parsed.config);
                    }
                    else {
                        const result = await call<{
                            uri: string;
                        }>(profile, "totp_preview", { config });
                        if (active) {
                            setValid(config);
                            callbacks.current.onValidity(true);
                            if (dirty.current)
                                callbacks.current.onChange(result.uri);
                        }
                    }
                }
                catch (e) {
                    if (active) {
                        setError(errorText(e));
                        callbacks.current.onValidity(false);
                    }
                }
            })();
        }, 250);
        return () => { active = false; clearTimeout(timer); };
    }, [config, profile]);
    async function importQr() {
        setBusy(true);
        setError("");
        try {
            const result = await call<{
                config: Config;
            } | null>(profile, "totp_qr_import");
            if (result && alive.current)
                change(result.config);
        }
        catch (e) {
            if (alive.current)
                setError(errorText(e));
        }
        finally {
            if (alive.current)
                setBusy(false);
        }
    }
    async function showQr() {
        if (qr) {
            setQr("");
            return;
        }
        if (!valid)
            return;
        const sequence = ++qrSequence.current;
        setBusy(true);
        setError("");
        try {
            const result = await call<{
                qr: string;
            }>(profile, "totp_preview", { config: valid, qr: true });
            if (alive.current && sequence === qrSequence.current)
                setQr(result.qr);
        }
        catch (e) {
            if (alive.current)
                setError(errorText(e));
        }
        finally {
            if (alive.current)
                setBusy(false);
        }
    }
    return <details className="totp-editor" open={!!value || undefined}>
    <summary>{t("ui.totpSetup")}</summary>
    <label>{t("ui.totpSecretOrUri")}<SecretInput value={config.secret} autoComplete="off" spellCheck={false} onChange={e => change({ ...config, secret: e.target.value })}/></label>
    <div className="totp-settings">
      <label>{t("ui.service")}<input value={config.issuer} onChange={e => change({ ...config, issuer: e.target.value })}/></label>
      <label>{t("ui.totpAccount")}<input value={config.account} onChange={e => change({ ...config, account: e.target.value })}/></label>
      <label>{t("ui.totpAlgorithm")}<select value={config.algorithm} onChange={e => change({ ...config, algorithm: e.target.value })}>{["SHA1", "SHA256", "SHA512"].map(algorithm => <option key={algorithm}>{algorithm}</option>)}</select></label>
      <label>{t("ui.totpDigits")}<select value={config.digits} onChange={e => change({ ...config, digits: Number(e.target.value) })}>{[6, 7, 8].map(digits => <option key={digits}>{digits}</option>)}</select></label>
      <label>{t("ui.totpPeriod")}<input type="number" min={1} max={86400} disabled={!config.secret} value={config.period} onChange={e => change({ ...config, period: Number(e.target.value) })}/></label>
    </div>
    <div className="totp-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void importQr()}>{t("ui.importTotpQr")}</button>
      <button type="button" className="secondary" disabled={busy || !valid} onClick={() => void showQr()}>{t(qr ? "ui.hideQr" : "ui.showQr")}</button>
      {config.secret && <button type="button" className="secondary" onClick={() => change({ ...config, secret: "" })}>{t("ui.removeTotp")}</button>}</div>
    {valid && <><h4>{t("ui.totpPreview")}</h4><Preview profile={profile} config={valid}/></>}
    {qr && <img className="totp-qr" src={qr} alt={t("ui.totpQr")}/>}
    {error && <p role="alert">{t(error)}</p>}
  </details>;
}

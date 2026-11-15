import { systemDateLocale } from "./i18n";
import { ChangeEvent, InputHTMLAttributes, KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "./i18n";
import { Icon } from "./Icon";
export function calendarValue(value: string, month = false): string {
    const pattern = month ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
    if (pattern.test(value)) {
        const [year, m, day = 1] = value.split("-").map(Number);
        const date = new Date(0);
        date.setFullYear(year, m - 1, day);
        date.setHours(0, 0, 0, 0);
        return year >= 1 && year <= 9999 && m >= 1 && m <= 12 && date.getFullYear() === year && date.getMonth() === m - 1 && date.getDate() === day ? value : "";
    }
    if (month) {
        const legacy = /^(\d{2})\/(\d{2}|\d{4})$/.exec(value);
        if (legacy)
            return calendarValue(`${legacy[2].length === 2 ? "20" : ""}${legacy[2]}-${legacy[1]}`, true);
    }
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()))
        return "";
    const date = `${parsed.getFullYear().toString().padStart(4, "0")}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
    return month ? date.slice(0, 7) : date;
}
export const dateField = (type: string, key: string) => key === "expires" || (type === "document" && key === "issued");
export function displayDate(value: string, month = false): string {
    const normalized = calendarValue(value, month);
    if (!normalized)
        return value;
    const [year, m, day = 1] = normalized.split("-").map(Number);
    const date = new Date(0);
    date.setFullYear(year, m - 1, day);
    date.setHours(0, 0, 0, 0);
    return new Intl.DateTimeFormat(systemDateLocale(), month ? { calendar: "gregory", year: "numeric", month: "2-digit" } : { calendar: "gregory", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
const clean = (value: string) => value.replace(/[\u200e\u200f\u061c]/g, "").replace(/\u00a0/g, " ");
// Date order and separators follow the OS locale independently of the UI language.
function layout(month: boolean) {
    const locale = systemDateLocale();
    const parts = new Intl.DateTimeFormat(locale, month ? { calendar: "gregory", year: "numeric", month: "2-digit" } : { calendar: "gregory", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(2006, 10, 22));
    const fields = parts.filter(part => ["day", "month", "year"].includes(part.type)).map(part => part.type);
    const pattern = parts.map(part => part.type === "year" ? "YYYY" : part.type === "month" ? "MM" : part.type === "day" ? "DD" : clean(part.value)).join("");
    const expression = "^" + parts.map(part => ["day", "month", "year"].includes(part.type) ? part.type === "year" ? "([0-9]{1,4})" : "([0-9]{2})" : clean(part.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") + "$";
    return { parts, fields, pattern, expression };
}
function asciiDigits(value: string) {
    const formatter = new Intl.NumberFormat(systemDateLocale(), { useGrouping: false });
    let result = clean(value);
    for (let digit = 0; digit < 10; digit++)
        result = result.replaceAll(clean(formatter.format(digit)), String(digit));
    return result;
}
export function parseDisplayDate(value: string, month = false): string | null {
    if (!value.trim())
        return "";
    const format = layout(month), match = new RegExp(format.expression).exec(asciiDigits(value));
    if (!match)
        return null;
    const numbers = Object.fromEntries(format.fields.map((field, index) => [field, Number(match[index + 1])]));
    const iso = `${String(numbers.year).padStart(4, "0")}-${String(numbers.month).padStart(2, "0")}${month ? "" : `-${String(numbers.day).padStart(2, "0")}`}`;
    return calendarValue(iso, month) || null;
}
function localDate(year: number, month: number, day = 1) { const value = new Date(0); value.setFullYear(year, month, day); value.setHours(0, 0, 0, 0); return value; }
function isoDate(date: Date, month = false) { return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}${month ? "" : `-${String(date.getDate()).padStart(2, "0")}`}`; }
function firstWeekday() {
    const locale = new Intl.Locale(systemDateLocale()) as Intl.Locale & {
        weekInfo?: {
            firstDay: number;
        };
        getWeekInfo?: () => {
            firstDay: number;
        };
    };
    return (locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay ?? (systemDateLocale() === "en-US" ? 7 : 1)) % 7;
}
export function DateInput({ value, month = false, onValueChange, onValidity, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
    value: string;
    month?: boolean;
    onValueChange?: (value: string) => void;
    onValidity?: (valid: boolean) => void;
}) {
    const { t } = useI18n();
    const validityCallback = useRef(onValidity);
    validityCallback.current = onValidity;
    useEffect(() => () => validityCallback.current?.(true), []);
    const generated = useId();
    const id = props.id ?? generated;
    const locale = systemDateLocale(), normalized = calendarValue(value, month);
    const [text, setText] = useState(normalized ? displayDate(value, month) : "");
    const [open, setOpen] = useState(false), [months, setMonths] = useState(month);
    const initial = normalized ? new Date(`${normalized}${month ? "-01" : ""}T12:00:00`) : new Date();
    const [cursor, setCursor] = useState({ year: initial.getFullYear(), month: initial.getMonth() });
    const [position, setPosition] = useState({ top: 0, left: 0 });
    const root = useRef<HTMLSpanElement>(null), input = useRef<HTMLInputElement>(null), popup = useRef<HTMLDivElement>(null), focusDate = useRef("");
    const format = layout(month);
    useEffect(() => { setText(normalized ? displayDate(value, month) : ""); input.current?.setCustomValidity(""); validityCallback.current?.(true); }, [value, month, locale]);
    const close = () => { setOpen(false); input.current?.focus(); };
    useEffect(() => {
        if (!open)
            return;
        const outside = (event: Event) => {
            if (event.target instanceof Node && !root.current?.contains(event.target) && !popup.current?.contains(event.target))
                setOpen(false);
        };
        document.addEventListener("pointerdown", outside);
        document.addEventListener("focusin", outside);
        return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); };
    }, [open]);
    useLayoutEffect(() => {
        if (!open)
            return;
        const place = () => {
            const rect = input.current?.getBoundingClientRect();
            if (!rect)
                return;
            if (rect.bottom < 0 || rect.top > window.innerHeight) {
                setOpen(false);
                return;
            }
            const width = popup.current?.offsetWidth || 320, height = popup.current?.offsetHeight || 350;
            const top = rect.bottom + 6 + height <= window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - height - 6);
            setPosition({ top, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) });
        };
        place();
        window.addEventListener("resize", place);
        document.addEventListener("scroll", place, true);
        const target = focusDate.current || normalized || isoDate(new Date(), month);
        popup.current?.querySelector<HTMLButtonElement>(`button[data-date="${target}"]`)?.focus();
        focusDate.current = "";
        return () => { window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); };
    }, [open, cursor, months]);
    function choose(date: Date) {
        if (date.getFullYear() < 1 || date.getFullYear() > 9999)
            return;
        const iso = isoDate(date, month);
        setText(displayDate(iso, month));
        input.current?.setCustomValidity("");
        validityCallback.current?.(true);
        onValueChange?.(iso);
        close();
    }
    function edit(event: ChangeEvent<HTMLInputElement>) {
        const raw = event.target.value;
        const literals = format.parts.filter(part => part.type === "literal").map(part => clean(part.value)).join("");
        const converted = asciiDigits(raw);
        if ([...converted].some(character => !/[0-9]/.test(character) && !literals.includes(character)))
            return;
        setText(raw);
        const iso = parseDisplayDate(raw, month);
        event.target.setCustomValidity(iso === null ? `${t("ui.dateFormat")}: ${format.pattern}` : "");
        validityCallback.current?.(iso !== null);
        if (iso !== null)
            onValueChange?.(iso);
    }
    function show() {
        const parsed = parseDisplayDate(text, month) || normalized;
        const date = parsed ? new Date(`${parsed}${month ? "-01" : ""}T12:00:00`) : new Date();
        setCursor({ year: date.getFullYear(), month: date.getMonth() });
        setMonths(month);
        setOpen(true);
    }
    function shift(offset: number) {
        const date = months ? localDate(cursor.year + offset, cursor.month) : localDate(cursor.year, cursor.month + offset);
        if (date.getFullYear() >= 1 && date.getFullYear() <= 9999)
            setCursor({ year: date.getFullYear(), month: date.getMonth() });
    }
    function keyboard(event: KeyboardEvent<HTMLDivElement>) {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
        }
        const target = event.target as HTMLElement;
        const date = target.dataset.date;
        if (!date)
            return;
        const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: months ? -3 : -7, ArrowDown: months ? 3 : 7 };
        if (!(event.key in offsets) && !["PageUp", "PageDown", "Home", "End"].includes(event.key))
            return;
        event.preventDefault();
        const parsed = new Date(`${date}${months ? "-01" : ""}T12:00:00`);
        if (event.key === "PageUp" || event.key === "PageDown") {
            if (months)
                parsed.setFullYear(parsed.getFullYear() + (event.key === "PageUp" ? -1 : 1));
            else {
                const day = parsed.getDate();
                parsed.setDate(1);
                parsed.setMonth(parsed.getMonth() + (event.key === "PageUp" ? -1 : 1));
                const last = localDate(parsed.getFullYear(), parsed.getMonth() + 1, 0).getDate();
                parsed.setDate(Math.min(day, last));
            }
        }
        else if (months)
            parsed.setMonth(parsed.getMonth() + (offsets[event.key] ?? (event.key === "Home" ? -parsed.getMonth() : 11 - parsed.getMonth())));
        else
            parsed.setDate(parsed.getDate() + (offsets[event.key] ?? (event.key === "Home" ? -(parsed.getDay() - firstWeekday() + 7) % 7 : 6 - (parsed.getDay() - firstWeekday() + 7) % 7)));
        if (parsed.getFullYear() < 1 || parsed.getFullYear() > 9999)
            return;
        focusDate.current = isoDate(parsed, months);
        setCursor({ year: parsed.getFullYear(), month: parsed.getMonth() });
    }
    const monthFormatter = new Intl.DateTimeFormat(locale, { calendar: "gregory", month: "long" });
    const monthNames = Array.from({ length: 12 }, (_, index) => monthFormatter.format(localDate(cursor.year, index)));
    const weekday = firstWeekday(), offset = (localDate(cursor.year, cursor.month).getDay() - weekday + 7) % 7;
    const dayFormatter = new Intl.DateTimeFormat(locale, { calendar: "gregory", year: "numeric", month: "long", day: "numeric", weekday: "long" });
    return <span ref={root} className="calendar-field">
    <input {...props} id={id} ref={input} type="text" data-date-input={month ? "month" : "date"} inputMode="numeric" autoComplete="off" placeholder={format.pattern} value={text} onChange={edit} aria-describedby={`${id}-format`} onKeyDown={event => {
            props.onKeyDown?.(event);
            if (event.key === "ArrowDown" && !props.disabled && !props.readOnly) {
                event.preventDefault();
                show();
            }
            if (event.key === "Escape" && open) {
                event.preventDefault();
                close();
            }
        }}/>
    <span className="sr-only" id={`${id}-format`}>{t("ui.dateFormat")}: {format.pattern}</span>
    <button type="button" className="calendar-toggle" aria-label={t("ui.chooseDate")} title={t("ui.chooseDate")} aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-calendar`} disabled={props.disabled || props.readOnly} onClick={() => open ? close() : show()}><Icon name="calendar"/></button>
    {open && createPortal(<div ref={popup} id={`${id}-calendar`} className="date-calendar" role="dialog" dir={root.current?.closest("[dir]")?.getAttribute("dir") ?? undefined} aria-label={t("ui.chooseDate")} style={position} onKeyDown={keyboard}>
      <div className="date-calendar-header">
        <button type="button" className="subtle" aria-label={t("ui.previousPeriod")} onClick={() => shift(-1)}>‹</button>
        <button type="button" className="subtle calendar-period" onClick={() => setMonths(current => month || !current)}>{months ? String(cursor.year) : `${monthNames[cursor.month]} ${cursor.year}`}</button>
        <button type="button" className="subtle" aria-label={t("ui.nextPeriod")} onClick={() => shift(1)}>›</button>
        <button type="button" className="subtle" aria-label={t("ui.closeCalendar")} onClick={close}>×</button>
      </div>
      {months ? <><label className="calendar-year-label">{t("ui.year")}<input type="number" min={1} max={9999} value={cursor.year} onChange={event => {
                    const year = Number(event.target.value);
                    if (Number.isInteger(year) && year >= 1 && year <= 9999)
                        setCursor(current => ({ ...current, year }));
                }}/></label>
        <div className="date-month-grid">{monthNames.map((name, index) => <button key={name} type="button" className="subtle" data-date={`${String(cursor.year).padStart(4, "0")}-${String(index + 1).padStart(2, "0")}`} aria-pressed={normalized === `${cursor.year}-${String(index + 1).padStart(2, "0")}`} onClick={() => month ? choose(localDate(cursor.year, index)) : (setCursor(current => ({ ...current, month: index })), setMonths(false))}>{name}</button>)}</div></> :
                <><div className="date-weekdays" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <span key={index}>{new Intl.DateTimeFormat(locale, { weekday: "short" }).format(localDate(2024, 0, 7 + (weekday + index) % 7))}</span>)}</div>
        <div className="date-day-grid">{Array.from({ length: 42 }, (_, index) => {
                        const date = localDate(cursor.year, cursor.month, index - offset + 1), iso = isoDate(date);
                        return <button key={iso} type="button" className={`subtle ${date.getMonth() !== cursor.month ? "other-month" : ""}`} data-date={iso} aria-label={dayFormatter.format(date)} aria-pressed={normalized === iso} aria-current={iso === isoDate(new Date()) ? "date" : undefined} disabled={date.getFullYear() < 1 || date.getFullYear() > 9999} onClick={() => choose(date)}>{new Intl.NumberFormat(locale, { useGrouping: false }).format(date.getDate())}</button>;
                    })}</div></>}
      <div className="date-calendar-footer"><button type="button" className="subtle" onClick={() => choose(new Date())}>{t("ui.today")}</button><button type="button" className="subtle" onClick={() => { setText(""); input.current?.setCustomValidity(""); validityCallback.current?.(true); onValueChange?.(""); close(); }}>{t("ui.clearDate")}</button></div>
    </div>, document.body)}
  </span>;
}

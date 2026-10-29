import { useSyncExternalStore } from "react";
import en from "./locales/en.json";
import ru from "./locales/ru.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import de from "./locales/de.json";
import pt from "./locales/pt.json";
import hans from "./locales/zh-Hans.json";
import hant from "./locales/zh-Hant.json";
import ja from "./locales/ja.json";
import hi from "./locales/hi.json";
import ar from "./locales/ar.json";
import { readLocal, writeLocal } from "./preferences";
export const languages: Record<string, string> = {
  en: "English",
  ru: "Русский",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  ja: "日本語",
  hi: "हिन्दी",
  ar: "العربية",
};
export const catalogs: Record<string, Record<string, string>> = {
  en,
  ru,
  es,
  fr,
  de,
  pt,
  "zh-Hans": hans,
  "zh-Hant": hant,
  ja,
  hi,
  ar,
};
export function resolveLocale(locale: string): string {
  const normalized = locale.replaceAll("_", "-").toLowerCase();
  const [base] = normalized.split("-");
  if (base === "zh") {
    const parts = normalized.split("-");
    if (parts.includes("hant")) return "zh-Hant";
    if (parts.includes("hans")) return "zh-Hans";
    return parts.some((p) => ["tw", "hk", "mo"].includes(p))
      ? "zh-Hant"
      : "zh-Hans";
  }
  return base in catalogs ? base : "en";
}
let systemLocale = typeof navigator !== "undefined" ? navigator.language : "en";
let preference = readLocal<string>("neruvalo.language", "auto");
if (preference !== "auto" && !(preference in languages)) preference = "auto";
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());
export function setSystemLocale(value: string) {
  systemLocale = value;
  changed();
}
export function setPreference(value: string) {
  preference = value in languages ? value : "auto";
  writeLocal("neruvalo.language", preference);
  changed();
}
export function currentLanguage() {
  return preference === "auto" ? resolveLocale(systemLocale) : preference;
}
export function translate(key: string, language = currentLanguage()): string {
  return catalogs[language]?.[key] ?? catalogs.en[key] ?? key;
}
export function useI18n() {
  const snapshot = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => preference + ":" + currentLanguage(),
    () => preference + ":" + currentLanguage(),
  );
  const language = snapshot.split(":")[1];
  return {
    t: (key: string) => translate(key, language),
    language,
    preference,
    setPreference,
  };
}

import { useSyncExternalStore } from "react";
import { readLocal, writeLocal } from "./preferences";

export const themes = ["system", "light", "dark", "dark-green", "nord", "solarized"] as const;
export type Theme = (typeof themes)[number];
export function validTheme(value: unknown): Theme {
  return themes.includes(value as Theme) ? (value as Theme) : "system";
}
let preference = validTheme(readLocal("neruvalo.theme", "system"));
const listeners = new Set<() => void>();
let system: MediaQueryList | undefined;

function apply() {
  document.documentElement.dataset.theme = preference === "system"
    ? (system?.matches ? "dark" : "light") : preference;
}

export function initializeTheme() {
  system?.removeEventListener("change", apply);
  system = window.matchMedia?.("(prefers-color-scheme: dark)");
  system?.addEventListener("change", apply);
  apply();
}

export function setTheme(value: string) {
  preference = validTheme(value);
  writeLocal("neruvalo.theme", preference);
  apply();
  listeners.forEach((listener) => listener());
}

export function useTheme() {
  const theme = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    () => preference,
  );
  return { theme, setTheme };
}

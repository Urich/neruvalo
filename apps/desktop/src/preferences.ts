export type Shortcut = {
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
} | null;
export type Shortcuts = Record<"login" | "password", Shortcut>;
// In-app commands only; no registration of global operating-system shortcuts.
export const defaultShortcuts: Shortcuts = {
  login: { code: "KeyU", ctrl: true, shift: true, alt: false, meta: false },
  password: { code: "KeyP", ctrl: true, shift: true, alt: false, meta: false },
};
export function shortcutText(s: Shortcut): string {
  if (!s) return "—";
  return [
    s.ctrl && "Ctrl",
    s.alt && "Alt",
    s.shift && "Shift",
    s.meta && "Meta",
    s.code.replace(/^Key|^Digit/, ""),
  ]
    .filter(Boolean)
    .join("+");
}
export function sameShortcut(a: Shortcut, b: Shortcut): boolean {
  return (
    !!a &&
    !!b &&
    a.code === b.code &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.meta === b.meta
  );
}
export function fromEvent(e: KeyboardEvent): Shortcut {
  if (!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2]))$/.test(e.code)) return null;
  const s = {
    code: e.code,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    meta: e.metaKey,
  };
  // Avoid OS switching/locking, browser editing and common menu/printing shortcuts.
  if (s.meta || !(s.ctrl || s.alt) || e.getModifierState("AltGraph"))
    return null;
  if (s.alt && !s.ctrl && ["F4", "KeyF", "KeyE"].includes(s.code)) return null;
  if (
    s.ctrl &&
    !s.shift &&
    !s.alt &&
    [
      "KeyA",
      "KeyC",
      "KeyV",
      "KeyX",
      "KeyZ",
      "KeyY",
      "KeyP",
      "KeyR",
      "KeyF",
      "KeyS",
      "KeyO",
      "KeyN",
      "KeyW",
      "KeyT",
      "KeyL",
    ].includes(s.code)
  )
    return null;
  if (
    s.code === "F4" ||
    s.code === "F5" ||
    s.code === "F11" ||
    s.code === "F12"
  )
    return null;
  return s;
}
export function readLocal<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
export function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Session-only if storage is unavailable. */
  }
}
export function isMobile() {
  return (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function loadShortcuts(): Shortcuts {
  const saved = readLocal<Shortcuts>("neruvalo.shortcuts", defaultShortcuts);
  const valid = (s: unknown) =>
    s === null ||
    (typeof s === "object" &&
      s !== null &&
      typeof (s as Exclude<Shortcut, null>).code === "string" &&
      ["ctrl", "alt", "shift", "meta"].every(
        (k) => typeof (s as Record<string, unknown>)[k] === "boolean",
      ));
  return saved &&
    valid(saved.login) &&
    valid(saved.password) &&
    !sameShortcut(saved.login, saved.password)
    ? saved
    : structuredClone(defaultShortcuts);
}

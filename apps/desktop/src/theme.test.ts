// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import themeBootstrap from "../public/theme-init.js?raw";
import { initializeTheme, setTheme, validTheme } from "./theme";

let dark: boolean;
let change: () => void;
beforeEach(() => {
  dark = false;
  change = () => {};
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return dark; },
    addEventListener: (_event: string, listener: () => void) => { change = listener; },
    removeEventListener: vi.fn(),
  }));
  initializeTheme();
  setTheme("system");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it("follows system changes while explicit palettes retain the user's choice", () => {
  expect(document.documentElement.dataset.theme).toBe("light");
  dark = true;
  change();
  expect(document.documentElement.dataset.theme).toBe("dark");
  for (const palette of ["light", "dark", "dark-green", "nord", "solarized"]) {
    setTheme(palette);
    dark = !dark;
    change();
    expect(document.documentElement.dataset.theme).toBe(palette);
    expect(JSON.parse(localStorage.getItem("neruvalo.theme")!)).toBe(palette);
  }
  setTheme("system");
  expect(document.documentElement.dataset.theme).toBe(dark ? "dark" : "light");
});

it("rejects invalid saved preferences", () => {
  for (const value of [null, {}, [], "unknown", "toString", 42]) {
    expect(validTheme(value)).toBe("system");
  }
});

it("keeps switching themes when local storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("unavailable"); });
  setTheme("nord");
  expect(document.documentElement.dataset.theme).toBe("nord");
});

it("applies saved preferences before React starts, including invalid or inaccessible storage", () => {
  const bootstrap = new Function("window", "document", "localStorage",
    themeBootstrap);
  for (const palette of ["light", "dark", "dark-green", "nord", "solarized", "system"]) {
    localStorage.setItem("neruvalo.theme", JSON.stringify(palette));
    dark = true;
    bootstrap(window, document, localStorage);
    expect(document.documentElement.dataset.theme).toBe(palette === "system" ? "dark" : palette);
  }
  localStorage.setItem("neruvalo.theme", "broken JSON");
  bootstrap(window, document, localStorage);
  expect(document.documentElement.dataset.theme).toBe("dark");
  dark = false;
  bootstrap(window, document, { getItem() { throw Error("unavailable"); } });
  expect(document.documentElement.dataset.theme).toBe("light");
});

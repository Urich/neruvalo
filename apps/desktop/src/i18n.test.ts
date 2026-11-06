import feedbackMessages from "../../../crates/server/src/verification/messages.json";
import { describe, it, expect } from "vitest";
import { catalogs, resolveLocale, translate } from "./i18n";
describe("bundled language catalogs", () => {
  it("preserves Unicode in theme labels in every language", () => {
    for (const catalog of Object.values(catalogs)) {
      for (const key of ["ui.theme", "ui.theme.system", "ui.theme.light", "ui.theme.dark", "ui.theme.dark-green", "ui.theme.nord", "ui.theme.solarized"]) {
        expect(catalog[key]).toBeTruthy();
        expect(catalog[key]).not.toMatch(/[?\uFFFD]/);
      }
    }
    expect(translate("ui.theme", "ru")).toBe("Тема оформления");
    expect(translate("ui.theme.dark", "ru")).toBe("Тёмная");
  });
  it("resolves regional locales, explicit Chinese scripts and unsupported locales", () => {
    for (const [locale, expected] of Object.entries({
      "ru-RU": "ru",
      pt_BR: "pt",
      "es-MX": "es",
      zh: "zh-Hans",
      "zh-SG": "zh-Hans",
      "zh-HK": "zh-Hant",
      "zh-TW": "zh-Hant",
      "zh-Hans-TW": "zh-Hans",
      "zh-Hant-CN": "zh-Hant",
      "it-IT": "en",
      C: "en",
    }))
      expect(resolveLocale(locale)).toBe(expected);
  });
  it("ships all eleven catalogs with the complete baseline and no blank translations", () => {
    expect(Object.keys(catalogs)).toHaveLength(11);
    for (const catalog of Object.values(catalogs)) {
      expect(Object.keys(catalog).sort()).toEqual(
        Object.keys(catalogs.en).sort(),
      );
      expect(Object.values(catalog).every((v) => v.trim().length > 0)).toBe(
        true,
      );
      expect(Object.keys(catalog).every((key) => key.startsWith("ui."))).toBe(true);
    }
    expect(translate("ui.password", "ja")).toBe("パスワード");
    expect(translate("ui.password", "unsupported")).toBe("Password");
    expect(translate("ui.proxy", "en")).toBe("Proxy");
    expect(translate("ui.proxy", "ru")).toBe("Прокси");
  });
});

it("provides every feedback message in all application languages", () => {
  for (const [language, values] of Object.entries(feedbackMessages.translations)) {
    expect(values).toHaveLength(feedbackMessages.keys.length);
    for (const key of feedbackMessages.keys) {
      expect(translate(`ui.${key}`, language)).toBe(catalogs[language][`ui.${key}`]);
      expect(catalogs[language][`ui.${key}`]).not.toContain("???");
    }
  }
  expect(translate("ui.incorrectPasswordOrDamagedData", "ru")).not.toMatch(/[a-z]/i);
});

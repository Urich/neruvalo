import { describe, it, expect } from "vitest";
import { catalogs, resolveLocale, translate } from "./i18n";
describe("bundled language catalogs", () => {
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
    }
    expect(translate("Пароль", "ja")).toBe("パスワード");
    expect(translate("Пароль", "unsupported")).toBe("Password");
  });
});

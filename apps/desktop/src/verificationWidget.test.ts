// @vitest-environment jsdom
import { expect, it } from "vitest";
// @ts-expect-error The upstream browser module is plain JavaScript.
import { activationLabel, collectBehavior } from "../../../crates/server/src/verification/widget.js";
import { languages } from "./i18n";
it("labels the real widget checkbox in every application language", async () => {
  const labels: Record<string, string> = {
    "en": "I am human",
    "ru": "\u042f \u0447\u0435\u043b\u043e\u0432\u0435\u043a",
    "es": "Soy humano",
    "fr": "Je suis un humain",
    "de": "Ich bin ein Mensch",
    "pt": "Sou humano",
    "zh-Hans": "\u6211\u662f\u4eba\u7c7b",
    "zh-Hant": "\u6211\u662f\u4eba\u985e",
    "ja": "\u79c1\u306f\u4eba\u9593\u3067\u3059",
    "hi": "\u092e\u0948\u0902 \u0907\u0902\u0938\u093e\u0928 \u0939\u0942\u0901",
    "ar": "\u0623\u0646\u0627 \u0625\u0646\u0633\u0627\u0646"
};
  expect(Object.keys(labels).sort()).toEqual(Object.keys(languages).sort());
  for (const [locale, label] of Object.entries(labels)) {
    expect(activationLabel(locale)).not.toContain("?");
    const element = document.createElement("div");
    const controller = new AbortController();
    const behavior = collectBehavior(element, {challenge_id:"test", expires_at:Date.now()/1000+60}, controller.signal, locale);
    expect(element.querySelector("label")!.textContent.trim()).toBe(label);
    const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    expect((await behavior).challenge_id).toBe("test");
  }
  expect(activationLabel("ru-RU")).toBe(labels.ru);
  expect(activationLabel("zh-Hans-TW")).toBe(labels["zh-Hans"]);
  expect(activationLabel("zh-TW")).toBe(labels["zh-Hant"]);
});

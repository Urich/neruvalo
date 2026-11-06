// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error The upstream browser module is plain JavaScript.
import { activationLabel, collectBehavior, configureMessages, GateveriqWidget, selectImages } from "../../../crates/server/src/verification/widget.js";
import bundle from "../../../crates/server/src/verification/messages.json";
import { languages, translate } from "./i18n";
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

afterEach(() => vi.unstubAllGlobals());
it("localizes PoW success, errors and image controls in all eleven languages", async () => {
  configureMessages(bundle);
  class WorkerMock {
    onmessage?: (event: unknown) => void;
    postMessage() { queueMicrotask(() => this.onmessage?.({data:{nonce:"0"}})); }
    terminate() {}
  }
  vi.stubGlobal("Worker", WorkerMock);
  const fetch = vi.fn().mockResolvedValue({ok:true,json:async () => ({verification_token:"verified"})});
  vi.stubGlobal("fetch", fetch);
  for (const locale of Object.keys(languages)) {
    const element = document.createElement("div");
    const widget = new GateveriqWidget(element);
    const result = widget.verify({challenge_id:"test",expires_at:Date.now()/1000+60}, {solutionURL:"https://gate.example/solutions",locale});
    const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    checkbox.checked = true; checkbox.dispatchEvent(new Event("change"));
    await expect(result).resolves.toBe("verified");
    expect(element.textContent).toBe(translate("ui.verificationCompleted", locale));
    const controller = new AbortController(); controller.abort();
    await expect(widget.verify({}, {locale,signal:controller.signal})).rejects.toThrow();
    expect(element.textContent).toBe(translate("ui.verificationFailed", locale));
    const visualController = new AbortController();
    const selection = selectImages(element, {instruction_key:"match_reference",reference:"ref",images:["image"],expires_at:Date.now()/1000+60}, visualController.signal, "", {locale});
    expect(element.querySelector("p")!.textContent).toBe(translate("ui.verificationVisualInstruction", locale));
    expect(element.querySelector('button[aria-pressed]')!.getAttribute("aria-label")).toBe(translate("ui.verificationImage",locale)+" 1");
    visualController.abort(); await expect(selection).rejects.toThrow();
  }
});

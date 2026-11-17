// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error The upstream browser module is plain JavaScript.
import { activationLabel, collectBehavior, configureMessages, GateveriqWidget, selectSlider, verifyVisual } from "../../../crates/server/src/verification/widget.js";
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
it("localizes PoW success, errors and slider controls in all eleven languages", async () => {
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
    const selection = selectSlider(element, {kind:"slider_puzzle",width:280,height:140,piece_size:40,max_position:240,piece_y:20,background:"data:image/png;base64,YQ==",piece:"data:image/png;base64,Yg==",expires_at:Date.now()/1000+60}, visualController.signal, "", {locale,theme:"dark"});
    const slider = element.querySelector(".gateveriq-slider")!;
    expect(slider.getAttribute("data-theme")).toBe("dark");
    const shadow = slider.shadowRoot!;
    expect(shadow.querySelector(".heading")!.textContent).toBe(translate("ui.verificationSliderInstruction", locale));
    expect(shadow.querySelector('input[type="range"]')!.getAttribute("aria-label")).toBe(translate("ui.verificationSliderPosition",locale));
    visualController.abort(); await expect(selection).rejects.toThrow();
  }
});

it("submits the slider with keyboard and respects image loading", async () => {
  configureMessages(bundle);
  const element = document.createElement("div");
  const selection = selectSlider(element, {kind:"slider_puzzle",width:280,height:140,piece_size:40,max_position:240,piece_y:20,background:"data:image/png;base64,YQ==",piece:"data:image/png;base64,Yg==",expires_at:Date.now()/1000+60}, new AbortController().signal, "", {locale:"ru"});
  const shadow = element.querySelector(".gateveriq-slider")!.shadowRoot!;
  const range = shadow.querySelector<HTMLInputElement>('input[type="range"]')!;
  expect(range.disabled).toBe(true);
  for (const image of shadow.querySelectorAll("img")) image.dispatchEvent(new Event("load"));
  expect(range.disabled).toBe(false);
  range.value = "120"; range.dispatchEvent(new Event("input"));
  range.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter"}));
  await expect(selection).resolves.toBe(120);
});

it("retries a rejected slider task and submits the replacement task to the current API", async () => {
  configureMessages(bundle);
  class WorkerMock {
    onmessage?: (event: unknown) => void;
    postMessage() { queueMicrotask(() => this.onmessage?.({data:{nonce:"proof"}})); }
    terminate() {}
  }
  vi.stubGlobal("Worker", WorkerMock);
  const visual = {kind:"slider_puzzle",task_id:"first",max_attempts:3,width:280,height:140,piece_size:40,max_position:240,piece_y:20,background:"data:image/png;base64,YQ==",piece:"data:image/png;base64,Yg==",expires_at:Date.now()/1000+60};
  const fetch = vi.fn()
    .mockResolvedValueOnce({ok:false,json:async () => ({error:{code:"INVALID_VISUAL_SOLUTION"},visual:{...visual,task_id:"replacement"}})})
    .mockResolvedValueOnce({ok:true,json:async () => ({verification_token:"verified"})});
  vi.stubGlobal("fetch", fetch);
  const element = document.createElement("div");
  const result = verifyVisual(element, {challenge_id:"challenge"}, visual, {serviceURL:"https://gate.example",locale:"ru",theme:"dark"});
  const submit = (position: number) => {
    const shadow = element.querySelector(".gateveriq-slider")!.shadowRoot!;
    for (const image of shadow.querySelectorAll("img")) image.dispatchEvent(new Event("load"));
    const range = shadow.querySelector<HTMLInputElement>("input")!;
    range.value = String(position); range.dispatchEvent(new Event("input"));
    range.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter"}));
  };
  const first = element.querySelector(".gateveriq-slider");
  submit(120);
  await vi.waitFor(() => expect(element.querySelector(".gateveriq-slider")).not.toBe(first));
  submit(180);
  await expect(result).resolves.toEqual({decision:"verified",verification_token:"verified"});
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[0][0])).toBe("https://gate.example/public/v1/web/visual/solutions");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({challenge_id:"challenge",task_id:"first",nonce:"proof",position:120});
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({challenge_id:"challenge",task_id:"replacement",nonce:"proof",position:180});
  expect(element.querySelector(".gateveriq-slider")!.shadowRoot!.textContent).toContain(translate("ui.verificationCompleted","ru"));
});

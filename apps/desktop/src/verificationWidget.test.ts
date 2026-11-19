// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
// @ts-expect-error The upstream browser module is plain JavaScript.
import { activationLabel, collectBehavior, configureMessages, GateveriqWidget, selectSlider, verifyVisual, verifyWebsiteAttempt } from "../../../crates/server/src/verification/widget.js";
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

const drawing = { drawImage: vi.fn() };
let sliderImages: HTMLImageElement[];
beforeEach(() => {
  vi.clearAllMocks();
  sliderImages = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(drawing as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(function (this: HTMLImageElement) {
    sliderImages.push(this);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function loadSliderImages() {
  const [background, piece] = sliderImages.slice(-2);
  background.dispatchEvent(new Event("load"));
  piece.dispatchEvent(new Event("load"));
  return { background, piece };
}
it("signals compact verification after activation and before submitting the proof", async () => {
  configureMessages(bundle);
  const onChecking = vi.fn();
  class WorkerMock {
    onmessage?: (event: unknown) => void;
    postMessage() {
      expect(onChecking).toHaveBeenCalledOnce();
      queueMicrotask(() => this.onmessage?.({ data: { nonce: "0" } }));
    }
    terminate() {}
  }
  vi.stubGlobal("Worker", WorkerMock);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ verification_token: "verified" }) }));
  const element = document.createElement("div");
  const result = verifyWebsiteAttempt(element, {
    decision: "verify", challenge: { challenge_id: "test", expires_at: Date.now() / 1000 + 60 },
  }, {
    serviceURL: "https://gate.example", locale: "ru", compact: true, onChecking,
  });
  expect(onChecking).not.toHaveBeenCalled();
  const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change"));
  expect(checkbox.disabled).toBe(true);
  expect(element.textContent?.trim()).toBe("Я человек");
  await expect(result).resolves.toEqual({ decision: "verified", verification_token: "verified" });
  expect(checkbox.checked).toBe(true);
  expect(element.querySelector('input[type="checkbox"]')).toBe(checkbox);
  expect(element.textContent?.trim()).toBe("Я человек");
});

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
  expect(drawing.drawImage).not.toHaveBeenCalled();
  const { background, piece } = loadSliderImages();
  expect(drawing.drawImage).toHaveBeenNthCalledWith(1, background, 0, 0, 280, 140);
  expect(drawing.drawImage).toHaveBeenNthCalledWith(2, piece, 0, 20, 40, 40);
  expect(range.disabled).toBe(false);
  expect(shadow.querySelector("button")).toBeNull();
  expect(shadow.querySelector('[role="status"]')?.textContent).toBe("");
  range.value = "120"; range.dispatchEvent(new Event("input"));
  expect(drawing.drawImage).toHaveBeenLastCalledWith(piece, 120, 20, 40, 40);
  range.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter"}));
  await expect(selection).resolves.toBe(120);
});

it.each(["mouse", "touch"])("moves the piece during a %s drag and submits only on release", async (pointerType) => {
  configureMessages(bundle);
  const element = document.createElement("div");
  const visual = {kind:"slider_puzzle",width:280,height:140,piece_size:40,max_position:240,piece_y:20,background:"data:image/png;base64,YQ==",piece:"data:image/png;base64,Yg==",expires_at:Date.now()/1000+60};
  const selection = selectSlider(element, visual, new AbortController().signal);
  const shadow = element.querySelector(".gateveriq-slider")!.shadowRoot!;
  const track = shadow.querySelector<HTMLElement>(".track")!;
  const handle = shadow.querySelector<HTMLElement>(".handle")!;
  const range = shadow.querySelector<HTMLInputElement>("input")!;
  const capture = vi.fn();
  Object.defineProperties(track, {clientWidth: {value: 280}, clientLeft: {value: 1}, setPointerCapture: {value: capture}});
  Object.defineProperty(handle, "offsetWidth", {value: 34});
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 0, 282, 40));
  const pointer = (type: string, clientX: number, pointerId = 1) => {
    track.dispatchEvent(new PointerEvent(type, {clientX, pointerId, pointerType, button: 0}));
  };

  pointer("pointerdown", 118);
  expect(capture).not.toHaveBeenCalled();
  const { piece } = loadSliderImages();
  pointer("pointerdown", 118);
  expect(capture).toHaveBeenCalledWith(1);
  pointer("pointermove", 241, 2);
  expect(range.valueAsNumber).toBe(0);
  pointer("pointermove", 241);
  expect(range.valueAsNumber).toBe(120);
  expect(drawing.drawImage).toHaveBeenLastCalledWith(piece, 120, visual.piece_y, visual.piece_size, visual.piece_size);
  expect(track.style.getPropertyValue("--slider-progress")).toBe("50%");
  expect(range.disabled).toBe(false);

  pointer("pointercancel", 241);
  pointer("pointerup", 241);
  expect(range.disabled).toBe(false);
  pointer("pointerdown", 241);
  pointer("pointerup", 302.5);
  await expect(selection).resolves.toBe(180);
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
  const submit = (position: number, message = "") => {
    const shadow = element.querySelector(".gateveriq-slider")!.shadowRoot!;
    loadSliderImages();
    expect(shadow.querySelector('[role="status"]')?.textContent).toBe(message);
    const range = shadow.querySelector<HTMLInputElement>("input")!;
    range.value = String(position); range.dispatchEvent(new Event("input"));
    range.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter"}));
  };
  const first = element.querySelector(".gateveriq-slider");
  submit(120);
  await vi.waitFor(() => expect(element.querySelector(".gateveriq-slider")).not.toBe(first));
  submit(180, translate("ui.verificationSliderRetry", "ru"));
  await expect(result).resolves.toEqual({decision:"verified",verification_token:"verified"});
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[0][0])).toBe("https://gate.example/public/v1/web/visual/solutions");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({challenge_id:"challenge",task_id:"first",nonce:"proof",position:120});
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({challenge_id:"challenge",task_id:"replacement",nonce:"proof",position:180});
  expect(element.querySelector(".gateveriq-slider")!.shadowRoot!.textContent).toContain(translate("ui.verificationCompleted","ru"));
});

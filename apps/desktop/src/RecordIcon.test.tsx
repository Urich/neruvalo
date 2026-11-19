// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { EntryIcon, IconEditor } from "./RecordIcon";
import { fieldsOf } from "./documents";
import { setPreference } from "./i18n";
import { empty } from "./model";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("shows imported images and standard icon zero without loading external URLs", () => {
  expect(renderToStaticMarkup(<EntryIcon name="login" data={{icon:"data:image/png;base64,AAAA"}} />)).toContain('<img');
  expect(renderToStaticMarkup(<EntryIcon name="login" data={{icon:"https://example.test/icon.png"}} />)).not.toContain('<img');
  expect(renderToStaticMarkup(<EntryIcon name="login" data={{keepass_icon_id:0}} />)).toContain('keepass-record-icon');
  expect(renderToStaticMarkup(<EntryIcon name="folder" data={{icon:null,keepass_icon_id:null}} />)).toContain('<svg');
});
it("shows imported expiry as a regular field and keeps TOTP masked", () => {
  const fields = fieldsOf({...empty(), fields:{expires:"2030-01-01T00:00:00+00:00",never_expires:"false",totp:"otpauth://totp/test?secret=AA"}});
  expect(fields.find(([key]) => key === "expires")?.[2]).toBe(false);
  expect(fields.find(([key]) => key === "totp")?.[2]).toBe(true);
  expect(fields.some(([key]) => key === "never_expires")).toBe(false);
});

it("opens the file chooser from the preview button and updates the preview", async () => {
  setPreference("ru");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const image = "data:image/png;base64,AAAA";
  const read = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
    Object.defineProperty(this, "result", { value: image });
    this.dispatchEvent(new Event("load"));
    this.dispatchEvent(new Event("loadend"));
  });
  function Editor() {
    const [value, setValue] = useState<string>();
    return <IconEditor name="login" value={value} onChange={setValue} />;
  }

  try {
    await act(async () => root.render(<Editor />));
    const button = host.querySelector<HTMLButtonElement>(".icon-file-button")!;
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const choose = vi.spyOn(input, "click");
    expect(input.hidden).toBe(true);
    expect(button.textContent).toContain("Выбрать иконку");
    await act(async () => button.click());
    expect(choose).toHaveBeenCalledOnce();

    const setFile = (file: File) => act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await setFile(new File(["text"], "icon.txt", { type: "text/plain" }));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    const file = new File(["icon"], "icon.png", { type: "image/png" });
    await setFile(file);
    expect(read).toHaveBeenCalledWith(file);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button.textContent).toContain("Заменить иконку");
    expect(button.querySelector("img")?.getAttribute("src")).toBe(image);

    const remove = host.querySelector<HTMLButtonElement>(".icon-file-remove")!;
    expect(remove.textContent).toBe("");
    expect(remove.querySelector("svg")).not.toBeNull();
    expect(remove.getAttribute("aria-label")).toBe("Удалить иконку");
    await act(async () => remove.click());
    expect(button.querySelector("img")).toBeNull();
    expect(button.textContent).toContain("Выбрать иконку");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});

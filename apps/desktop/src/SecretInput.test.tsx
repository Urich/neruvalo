// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { SecretInput, SecretTextarea } from "./SecretInput";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("toggles fields independently without changing their values or submitting", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); let submits = 0;
  try {
    await act(async () => root.render(<form onSubmit={event => { event.preventDefault(); submits++; }}><SecretInput defaultValue="example" /><SecretInput defaultValue="second" /><SecretTextarea defaultValue={'line1\nline2'} /></form>));
    const inputs = host.querySelectorAll("input");
    const toggles = host.querySelectorAll("button");
    expect(inputs[0].type).toBe("password");
    await act(async () => toggles[0].click());
    expect(inputs[0].type).toBe("text");
    expect(inputs[0].value).toBe("example");
    expect(inputs[1].type).toBe("password");
    expect(toggles[0].getAttribute("aria-controls")).toBe(inputs[0].id);
    await act(async () => toggles[2].click());
    expect(host.querySelector("textarea")!.classList.contains("secret-masked")).toBe(false);
    expect(host.querySelector("textarea")!.value).toBe('line1\nline2');
    expect(submits).toBe(0);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

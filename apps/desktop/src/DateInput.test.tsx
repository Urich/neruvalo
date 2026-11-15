// @vitest-environment jsdom
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { calendarValue,DateInput,displayDate,parseDisplayDate } from "./DateInput";
import { setPreference,setSystemLocale } from "./i18n";
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let root:Root,host:HTMLDivElement;
const changed=vi.fn();
beforeEach(()=>{setPreference("ru");setSystemLocale("ru-RU");changed.mockReset();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function mount(value="2030-12-31",month=false){await act(async()=>root.render(<DateInput value={value} month={month} onValueChange={changed}/>));}
async function click(element:HTMLElement){await act(async()=>element.click());}
function field(){return host.querySelector<HTMLInputElement>("input")!;}
async function fill(value:string){await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field(),value);field().dispatchEvent(new Event("input",{bubbles:true}));});}
it("uses the system date locale independently of interface language",async()=>{
  setPreference("en");await mount();expect(field().value).toBe("31.12.2030");expect(field().type).toBe("text");
  expect(displayDate("2030-12-31")).toBe("31.12.2030");expect(parseDisplayDate("31.12.2030")).toBe("2030-12-31");
  setSystemLocale("en-US");expect(displayDate("2030-12-31")).toBe("12/31/2030");expect(parseDisplayDate("12/31/2030")).toBe("2030-12-31");
});
it("opens an application calendar, selects a day and restores field focus",async()=>{
  await mount();await click(host.querySelector("button")!);
  const calendar=document.querySelector<HTMLElement>('.date-calendar[role="dialog"]')!;expect(calendar).not.toBeNull();
  await click(calendar.querySelector<HTMLButtonElement>('[data-date="2030-12-15"]')!);
  expect(changed).toHaveBeenLastCalledWith("2030-12-15");expect(document.querySelector(".date-calendar")).toBeNull();expect(document.activeElement).toBe(field());
});
it("rejects invalid dates and letters while storing valid input as ISO",async()=>{
  await mount();await fill("31.02.2030");expect(field().validity.valid).toBe(false);expect(changed).not.toHaveBeenCalled();
  await fill("15.01.2031");expect(field().validity.valid).toBe(true);expect(changed).toHaveBeenLastCalledWith("2031-01-15");
  const before=changed.mock.calls.length;await fill("abc");expect(field().value).not.toBe("abc");expect(changed.mock.calls).toHaveLength(before);
});
it("clears the date to unlimited and offers a month grid for cards",async()=>{
  await mount("09/28",true);expect(field().value).toBe("09.2028");expect(calendarValue("09/28",true)).toBe("2028-09");
  await click(host.querySelector("button")!);await click(document.querySelector<HTMLButtonElement>('[data-date="2028-05"]')!);expect(changed).toHaveBeenLastCalledWith("2028-05");
  await click(host.querySelector("button")!);await click([...document.querySelectorAll<HTMLButtonElement>(".date-calendar button")].find(button=>button.textContent==="Очистить дату")!);
  expect(changed).toHaveBeenLastCalledWith("");expect(field().value).toBe("");expect(field().validity.valid).toBe(true);
});
it("supports keyboard navigation across month boundaries and Escape",async()=>{
  await mount();await click(host.querySelector("button")!);
  const selected=document.querySelector<HTMLButtonElement>('[data-date="2030-12-31"]')!;
  await act(async()=>selected.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true})));
  expect((document.activeElement as HTMLElement).dataset.date).toBe("2031-01-01");
  await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  expect(document.querySelector(".date-calendar")).toBeNull();expect(document.activeElement).toBe(field());
});
it("rejects impossible ISO dates and respects read-only fields",async()=>{
  expect(calendarValue("")).toBe("");expect(calendarValue("2025-02-29")).toBe("");expect(calendarValue("2024-02-29")).toBe("2024-02-29");
  await act(async()=>root.render(<DateInput value="" readOnly/>));expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
});

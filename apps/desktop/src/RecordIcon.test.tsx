import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EntryIcon } from "./RecordIcon";
import { fieldsOf } from "./documents";
import { empty } from "./model";
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

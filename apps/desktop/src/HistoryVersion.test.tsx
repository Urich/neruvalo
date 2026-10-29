import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HistoryVersion } from "./HistoryVersion";
import { empty } from "./model";
import { setPreference } from "./i18n";

describe("historical record display", () => {
  it("shows version contents while masking card secrets", () => {
    setPreference("ru");
    const html = renderToStaticMarkup(
      <HistoryVersion
        entry={{
          record_id: "record",
          version_id: "version",
          revision: 2,
          archived: true,
          data: {
            ...empty("bank_card"),
            title: "Previous card",
            notes: "Old note",
            fields: { holder: "Alice", cvv: "SECRET-CVV", pin: "SECRET-PIN" },
          },
        }}
        disabled
        onRestore={() => {}}
      />,
    );
    expect(html).toContain("Previous card");
    expect(html).toContain("Old note");
    expect(html).toContain("Alice");
    expect(html).toContain("в архиве");
    expect(html).not.toContain("SECRET-CVV");
    expect(html).not.toContain("SECRET-PIN");
    expect(html).toContain('disabled=""');
  });
});

import { Data, types } from "./model";
export const documentTemplates = [
  "custom",
  "passport",
  "national_id",
  "driver_license",
  "visa",
  "residence_permit",
  "insurance",
] as const;
export const templateLabels: Record<string, string> = {
  custom: "Другой документ",
  passport: "Паспорт",
  national_id: "Удостоверение личности",
  driver_license: "Водительское удостоверение",
  visa: "Виза",
  residence_permit: "Вид на жительство",
  insurance: "Страховой полис",
};
export function fieldsOf(data: Data): [string, string, boolean, boolean?][] {
  const known = types[data.record_type]?.fields ?? [];
  const names = new Set(known.map((f) => f[0]));
  return [
    ...known,
    ...Object.keys(data.fields)
      .filter(
        (k) => !names.has(k) && !["template", "never_expires"].includes(k),
      )
      .map(
        (k) =>
          [k, k.startsWith("custom:") ? k.slice(7) : k, true, false] as [
            string,
            string,
            boolean,
            boolean?,
          ],
      ),
  ];
}

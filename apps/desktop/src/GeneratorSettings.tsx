import { GeneratorOptions } from "./passwordGenerator";
import { useI18n } from "./i18n";
export function GeneratorSettings({
  value,
  onChange,
}: {
  value: GeneratorOptions;
  onChange: (value: GeneratorOptions) => void;
}) {
  const { t } = useI18n();
  const categories = ["lowercase", "uppercase", "digits", "symbols"] as const;
  const labels = [
    "ui.lowercaseLettersAZ",
    "ui.uppercaseLettersAZ",
    "ui.digits09",
    "ui.specialCharacters",
  ];
  return (
    <section className="generator-settings">
      <h2>{t("ui.passwordGenerator")}</h2>
      <p className="muted">{t("ui.settingForThisDevice")}</p>
      <label>
        {t("ui.passwordLength")}
        <select
          value={value.length}
          onChange={(e) =>
            onChange({ ...value, length: Number(e.target.value) })
          }
        >
          {Array.from({ length: 121 }, (_, i) => i + 8).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      {categories.map((key, i) => (
        <label className="generator-option" key={key}>
          <input
            type="checkbox"
            checked={value[key]}
            disabled={
              value[key] && categories.filter((k) => value[k]).length === 1
            }
            onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
          />
          <span>{t(labels[i])}</span>
        </label>
      ))}
      <label className="generator-option">
        <input
          type="checkbox"
          checked={value.excludeSimilar}
          onChange={(e) =>
            onChange({ ...value, excludeSimilar: e.target.checked })
          }
        />
        <span>{t("ui.excludeSimilarCharactersIL1O0O")}</span>
      </label>
      <p className="muted">
        {t(
          "ui.everySelectedCharacterSetIsUsedPasswordsAreGeneratedLocally",
        )}
      </p>
    </section>
  );
}

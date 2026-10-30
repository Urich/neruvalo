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
    "Строчные буквы (a–z)",
    "Заглавные буквы (A–Z)",
    "Цифры (0–9)",
    "Специальные символы",
  ];
  return (
    <section className="generator-settings">
      <h2>{t("Генератор паролей")}</h2>
      <p className="muted">{t("Настройка этого устройства")}</p>
      <label>
        {t("Длина пароля")}
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
        <span>{t("Исключать похожие символы (I, l, 1, O, 0, o)")}</span>
      </label>
      <p className="muted">
        {t(
          "Каждый выбранный набор символов обязательно используется. Пароль создаётся локально.",
        )}
      </p>
    </section>
  );
}

export type Data = {
  record_type: string;
  schema_version: number;
  title: string;
  fields: Record<string, string>;
  notes: string;
  folder: string;
  group_id?: string | null;
  tags: string[];
};
export type Entry = {
  record_id: string;
  version_id: string;
  revision: number;
  archived: boolean;
  data: Data;
};
export type Profile = { id: string; login: string; server: string };
export const types: Record<
  string,
  { label: string; icon: string; fields: [string, string, boolean, boolean?][] }
> = {
  login: {
    label: "Логин и пароль",
    icon: "login",
    fields: [
      ["login", "Логин", false],
      ["password", "Пароль", true],
      ["url", "Адрес сайта", false],
      ["totp", "Секрет TOTP", true],
    ],
  },
  bank_card: {
    label: "Банковская карта",
    icon: "bank_card",
    fields: [
      ["number", "Номер карты", true],
      ["holder", "Держатель", false],
      ["expires", "Срок действия", false],
      ["bank", "Банк", false],
      ["network", "Платёжная система", false],
      ["cvv", "CVV / CVC", true],
      ["pin", "PIN", true],
    ],
  },
  note: { label: "Заметка", icon: "note", fields: [] },
  bank_account: {
    label: "Банковский счёт",
    icon: "bank_account",
    fields: [
      ["holder", "Владелец", false],
      ["number", "Номер счёта / IBAN", true],
      ["bank", "Банк", false],
      ["bic", "БИК", false],
      ["swift", "SWIFT", false],
      ["details", "Реквизиты", true, true],
    ],
  },
  api_token: {
    label: "API-ключ / токен",
    icon: "api_token",
    fields: [
      ["secret", "Ключ / токен", true],
      ["service", "Сервис", false],
      ["url", "Адрес", false],
      ["expires", "Срок действия", false],
    ],
  },
  ssh_key: {
    label: "SSH-ключ",
    icon: "ssh_key",
    fields: [
      ["private", "Приватный ключ", true, true],
      ["public", "Публичный ключ", false, true],
      ["passphrase", "Пароль ключа", true],
    ],
  },
  document: {
    label: "Документ",
    icon: "document",
    fields: [
      ["kind", "Тип документа", false],
      ["country", "Страна / организация", false],
      ["number", "Номер", true],
      ["holder", "Владелец", false],
      ["issuer", "Кем выдан", false],
      ["issued", "Дата выдачи", false],
      ["expires", "Действует до", false],
    ],
  },
  crypto_wallet: {
    label: "Криптокошелёк",
    icon: "crypto_wallet",
    fields: [
      ["application", "Приложение / устройство", false],
      ["network", "Сети", false],
      ["addresses", "Публичные адреса", false, true],
      ["seed", "Seed-фраза", true],
      ["passphrase", "Дополнительная passphrase", true],
      ["private_keys", "Приватные ключи", true, true],
    ],
  },
};
export const empty = (type = "login"): Data => ({
  record_type: type,
  schema_version: 1,
  title: "",
  fields: {},
  notes: "",
  folder: "",
  tags: [],
});
export function filterEntries(
  entries: Entry[],
  query: string,
  kind: string,
  archive: boolean,
) {
  const q = query.toLocaleLowerCase();
  return entries.filter(
    (e) =>
      e.archived === archive &&
      (!kind || e.data.record_type === kind) &&
      [e.data.title, e.data.folder, ...e.data.tags].some((s) =>
        s.toLocaleLowerCase().includes(q),
      ),
  );
}
export function errorText(error: unknown): string {
  const s = error instanceof Error ? error.message : String(error);
  if (s.includes("GROUP_NOT_FOUND"))
    return "Группа недоступна. Синхронизируйте устройства.";
  if (s.includes("INVALID_GROUP")) return "Недопустимая структура групп.";
  if (s.includes("GROUP_OPERATION_REQUIRED"))
    return "Для группы требуется отдельное действие.";
  if (s.includes("SERVER_PIN_MISMATCH"))
    return "Этот аккаунт или сертификат относится к другому серверу.";
  if (s.includes("ACCOUNT_EXISTS"))
    return "Аккаунт с таким логином или email уже существует.";
  if (s.includes("INVALID_EMAIL_CODE"))
    return "Неверный или просроченный код подтверждения.";
  if (s.includes("RATE_LIMITED"))
    return "Слишком много запросов. Повторите позже.";
  if (
    s.includes("SERVER_ID_CHANGED") ||
    s.includes("SERVER_KEY_CHANGED") ||
    s.includes("PUBLIC_KEY_MISMATCH") ||
    s.includes("ACCOUNT_CHANGED")
  )
    return "Сервер или ключи аккаунта изменились. Вход остановлен.";
  if (s.includes("UNSUPPORTED_"))
    return "Версия сервера или данных не поддерживается.";
  if (s.includes("RECORD_VERSION_MISMATCH"))
    return "Запись изменена на другом устройстве. Синхронизируйте устройства.";
  if (s.includes("SYNCHRONIZATION_REQUIRED"))
    return "Перед сохранением синхронизируйте устройства и заново откройте запись.";
  if (s.includes("AUTH_FAILED"))
    return "Не удалось подтвердить вход. Проверьте логин и мастер-пароль.";
  if (s.includes("OFFLINE_READ_ONLY"))
    return "Офлайн доступен только просмотр.";
  if (s.includes("LOCKED")) return "Хранилище заблокировано.";
  return /^[A-Z][A-Z_]{3,}$/.test(s)
    ? "Операция не выполнена. Проверьте соединение и повторите."
    : s;
}

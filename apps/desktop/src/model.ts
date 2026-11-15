import { catalogs } from "./i18n";
// `data` is an opaque native session handle; file bytes and keys never enter the webview.
export type Attachment = { id: string; name: string; size: number; data: string };
export type Data = {
  icon?: string;
  keepass_icon_id?: number;
  created_at?: number;
  modified_at?: number;
  archived_at?: number;
  attachments?: Attachment[];
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
  summary?: boolean;
  row_loaded?: boolean;
  received?: boolean;
  owner_login?: string;
  share_id?: string;
  source_record_id?: string;
  share_count?: number;
  record_id: string;
  version_id: string;
  revision: number;
  archived: boolean;
  data: Data;
};
export type Profile = { id: string; login: string; server: string; local?: boolean };
export const types: Record<
  string,
  { label: string; icon: string; fields: [string, string, boolean, boolean?][] }
> = {
  login: {
    label: "ui.loginAndPassword",
    icon: "login",
    fields: [
      ["login", "ui.username", false],
      ["password", "ui.password", true],
      ["url", "ui.websiteAddress", false],
      ["totp", "ui.totpSecret", true],
      ["expires", "ui.expiry", false],
    ],
  },
  bank_card: {
    label: "ui.bankCard",
    icon: "bank_card",
    fields: [
      ["number", "ui.cardNumber", true],
      ["holder", "ui.cardholder", false],
      ["expires", "ui.expiry", false],
      ["bank", "ui.bank", false],
      ["network", "ui.cardNetwork", false],
      ["cvv", "CVV / CVC", true],
      ["pin", "PIN", true],
    ],
  },
  note: { label: "ui.note", icon: "note", fields: [] },
  bank_account: {
    label: "ui.bankAccount",
    icon: "bank_account",
    fields: [
      ["holder", "ui.owner", false],
      ["number", "ui.accountNumberIban", true],
      ["bank", "ui.bank", false],
      ["bic", "ui.bankIdentifier", false],
      ["swift", "SWIFT", false],
      ["details", "ui.bankDetails", true, true],
    ],
  },
  api_token: {
    label: "ui.apiKeyToken",
    icon: "api_token",
    fields: [
      ["secret", "ui.keyToken", true],
      ["service", "ui.service", false],
      ["url", "ui.address", false],
      ["expires", "ui.expiry", false],
    ],
  },
  ssh_key: {
    label: "ui.sshKey",
    icon: "ssh_key",
    fields: [
      ["private", "ui.privateKey", true, true],
      ["public", "ui.publicKey", false, true],
      ["passphrase", "ui.keyPassphrase", true],
    ],
  },
  document: {
    label: "ui.document",
    icon: "document",
    fields: [
      ["kind", "ui.documentType", false],
      ["country", "ui.countryOrganization", false],
      ["number", "ui.number", true],
      ["holder", "ui.owner", false],
      ["issuer", "ui.issuedBy", false],
      ["issued", "ui.issueDate", false],
      ["expires", "ui.validUntil", false],
    ],
  },
  crypto_wallet: {
    label: "ui.cryptoWallet",
    icon: "crypto_wallet",
    fields: [
      ["application", "ui.applicationDevice", false],
      ["network", "ui.networks", false],
      ["addresses", "ui.publicAddresses", false, true],
      ["seed", "ui.seedPhrase", true],
      ["passphrase", "ui.additionalPassphrase", true],
      ["private_keys", "ui.privateKeys", true, true],
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
export function isUnsupportedVaultFormat(error: unknown): boolean {
  return /UNSUPPORTED_(?:VAULT_FORMAT|LOCAL_SCHEMA|PROTOCOL|FORMAT|TYPE|ATTACHMENT_FORMAT)\b|unsupported envelope/.test(String(error));
}
export function errorText(error: unknown): string {
  const s = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, "");
  if (Object.hasOwn(catalogs.en, s)) return s;
  if (isUnsupportedVaultFormat(s)) return "ui.unsupportedVaultFormat";
  const messages: [RegExp, string][] = [
    [/INVALID_TOTP_QR/, "invalidTotpQr"],
    [/INVALID_TOTP_TIME/, "invalidTotpTime"],
    [/INVALID_TOTP/, "invalidTotp"],
    [/KEEPASS_OPEN_FAILED|KEEPASS_INVALID_KEYFILE|KEEPASS_KEY_REQUIRED|KEEPASS_INVALID_FILE/, "keepassOpenFailed"],
    [/KEEPASS_RESOURCE_LIMIT/, "keepassResourceLimit"],
    [/KEEPASS_UNSUPPORTED_VERSION/, "keepassUnsupported"],
    [/KEEPASS_IMPORT_UNCERTAIN/, "keepassUncertain"],
    [/KEEPASS_IMPORT_PENDING/, "keepassPending"],
    [/KEEPASS_IMPORT_BLOCKED/, "keepassBlocked"],
    [/KEEPASS_IMPORT_MISSING|KEEPASS_PROFILE_CHANGED/, "keepassMissing"],
    [/KEEPASS_FOLDER_REQUIRED/, "keepassFolder"],
    [/incorrect secret or damaged data|INVALID_PASSWORD/i, "incorrectPasswordOrDamagedData"],
    [/master password of at least 12/i, "masterPasswordTooShort"],
    [/INVALID_VAULT_NAME/, "invalidVaultName"],
    [/INVALID_BACKUP|invalid (?:salt|nonce|root key)|invalid profile|Invalid recovery secret/i, "invalidBackup"],
    [/BACKUP_TOO_LARGE/, "backupTooLarge"],
    [/IMPORT_TOO_LARGE/, "importTooLarge"],
    [/already exists|os error (?:80|183)\b/i, "backupFileExists"],
    [/Title is required/i, "recordTitleRequired"],
    [/Invalid server URL|HTTPS is required|Use the server origin|relative URL without a base|empty host|invalid port/i, "invalidServerAddress"],
    [/ONLINE_LOGIN_REQUIRED|LOCAL_PROFILE_REQUIRED/, "onlineLoginRequired"],
    [/SAVE_RESULT_UNKNOWN/, "saveResultUnknown"],
    [/VERIFICATION_EXPIRED/, "verificationExpired"],
    [/VERIFICATION_CANCELLED/, "verificationCancelled"],
    [/VERIFICATION_|Missing verification token|Worker failed/, "verificationFailed"],
    [/ACCESS_DENIED|FORBIDDEN/, "accessDenied"],
    [/ATTACHMENT_TOO_LARGE|ATTACHMENTS_TOO_LARGE|TOO_MANY_ATTACHMENTS/, "attachmentLimits"],
    [/INVALID_ATTACHMENT/, "invalidAttachment"],
    [/Record exceeds|Server response too large/, "dataTooLarge"],
  ];
  for (const [pattern, key] of messages) if (pattern.test(s)) return `ui.${key}`;
  if (s.includes("INVALID_PROXY_CONFIG"))
    return "ui.couldNotSaveProxySettingsCheckTheProxyAddressAndType";
  if (s.includes("SHARING_VERSION_MISMATCH"))
    return "ui.sharingHasChangedSynchronizeYourDevicesAndTryAgain";
  if (s.includes("ALREADY_SHARED"))
    return "ui.thisUserAlreadyHasAccess";
  if (s.includes("ACCOUNT_NOT_FOUND")) return "ui.userNotFound";
  if (s.includes("CANNOT_SHARE_WITH_SELF"))
    return "ui.youCannotShareAnEntryWithYourself";
  if (s.includes("GROUP_NOT_FOUND"))
    return "ui.groupUnavailableSynchronizeYourDevices";
  if (s.includes("INVALID_GROUP")) return "ui.invalidGroupStructure";
  if (s.includes("GROUP_OPERATION_REQUIRED"))
    return "ui.useAGroupSpecificAction";
  if (s.includes("SERVER_PIN_MISMATCH"))
    return "ui.thisAccountOrRecoveryFileBelongsToAnotherServer";
  if (s.includes("ACCOUNT_EXISTS"))
    return "ui.anAccountWithThisUsernameOrEmailAlreadyExists";
  if (s.includes("INVALID_EMAIL_CODE"))
    return "ui.invalidOrExpiredVerificationCode";
  if (s.includes("RATE_LIMITED"))
    return "ui.tooManyRequestsTryAgainLater";
  if (
    s.includes("SERVER_ID_CHANGED") ||
    s.includes("SERVER_KEY_CHANGED") ||
    s.includes("PUBLIC_KEY_MISMATCH") ||
    s.includes("ACCOUNT_CHANGED")
  )
    return "ui.serverIdentityOrAccountKeysChangedSignInStopped";
  if (s.includes("UNSUPPORTED_"))
    return "ui.serverOrDataVersionIsNotSupported";
  if (s.includes("RECORD_VERSION_MISMATCH"))
    return "ui.thisEntryWasChangedOnAnotherDeviceSynchronizeYourDevices";
  if (s.includes("SYNCHRONIZATION_REQUIRED"))
    return "ui.synchronizeAndReopenTheEntryBeforeSaving";
  if (s.includes("AUTH_FAILED"))
    return "ui.signInFailedCheckYourUsernameAndPassword";
  if (s.includes("OFFLINE_READ_ONLY"))
    return "ui.offlineAccessIsReadOnly";
  if (s.includes("LOCKED")) return "ui.vaultIsLocked";
  return "ui.operationFailedCheckYourConnectionAndTryAgain";
}

export function passwordExpired(data: Data, now = Date.now()): boolean {
  if (data.record_type !== "login") return false;
  if (data.fields.never_expires === "true" || !data.fields.expires) return false;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data.fields.expires);
  const expiry = date ? new Date(Number(date[1]),Number(date[2])-1,Number(date[3])+1).getTime() : Date.parse(data.fields.expires);
  return Number.isFinite(expiry) && expiry <= now;
}

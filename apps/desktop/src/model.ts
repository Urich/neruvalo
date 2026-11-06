import { catalogs } from "./i18n";
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
export function errorText(error: unknown): string {
  const s = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, "");
  if (Object.hasOwn(catalogs.en, s)) return s;
  const messages: [RegExp, string][] = [
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

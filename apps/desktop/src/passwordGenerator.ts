export type GeneratorOptions = {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  excludeSimilar: boolean;
};
export const defaultGenerator: GeneratorOptions = {
  length: 20,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: true,
  excludeSimilar: true,
};
export function normalizeGenerator(value: unknown): GeneratorOptions {
  const result = { ...defaultGenerator };
  if (!value || typeof value !== "object") return result;
  const v = value as Record<string, unknown>;
  for (const key of [
    "lowercase",
    "uppercase",
    "digits",
    "symbols",
    "excludeSimilar",
  ] as const)
    if (typeof v[key] === "boolean") result[key] = v[key];
  if (
    typeof v.length === "number" &&
    Number.isInteger(v.length) &&
    v.length >= 8 &&
    v.length <= 128
  )
    result.length = v.length;
  if (
    !result.lowercase &&
    !result.uppercase &&
    !result.digits &&
    !result.symbols
  )
    return { ...result, lowercase: true };
  return result;
}
export function generatePassword(options: GeneratorOptions): string {
  if (
    !Number.isInteger(options.length) ||
    options.length < 8 ||
    options.length > 128
  )
    throw Error("Invalid password length");
  const groups = [
    options.lowercase && "abcdefghijklmnopqrstuvwxyz",
    options.uppercase && "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    options.digits && "0123456789",
    options.symbols && "!@#$%^&*()-_=+[]{};:,.?",
  ]
    .filter((s): s is string => !!s)
    .map((s) => (options.excludeSimilar ? s.replace(/[Il1O0o]/g, "") : s));
  if (!groups.length) throw Error("No character sets selected");
  const alphabet = groups.join("");
  // Rejection sampling avoids modulo bias. Reject whole candidates until each
  // selected category occurs, preserving uniformity over the allowed passwords.
  const limit = 256 - (256 % alphabet.length);
  for (let attempt = 0; attempt < 10000; attempt++) {
    let candidate = "";
    while (candidate.length < options.length) {
      const bytes = new Uint8Array(128);
      globalThis.crypto.getRandomValues(bytes);
      for (const byte of bytes) {
        if (byte >= limit) continue;
        candidate += alphabet[byte % alphabet.length];
        if (candidate.length === options.length) break;
      }
    }
    if (groups.every((g) => [...candidate].some((c) => g.includes(c))))
      return candidate;
  }
  throw Error("Password generation failed");
}

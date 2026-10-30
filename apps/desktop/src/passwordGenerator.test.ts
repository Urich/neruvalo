import { describe, it, expect, vi, afterEach } from "vitest";
import {
  defaultGenerator,
  generatePassword,
  normalizeGenerator,
} from "./passwordGenerator";
afterEach(() => vi.restoreAllMocks());
describe("password generator", () => {
  it("honors lengths, categories and excluded lookalikes", () => {
    for (const length of [8, 20, 128])
      for (let i = 0; i < 10; i++) {
        const password = generatePassword({ ...defaultGenerator, length });
        expect(password).toHaveLength(length);
        for (const pattern of [
          /[a-z]/,
          /[A-Z]/,
          /[2-9]/,
          /[!@#$%^&*()\-_=+\[\]{};:,.?]/,
        ])
          expect(password).toMatch(pattern);
        expect(password).not.toMatch(/[Il1O0o]/);
      }
  });
  it("supports digit-only policies and rejects invalid policies", () => {
    expect(
      generatePassword({
        ...defaultGenerator,
        lowercase: false,
        uppercase: false,
        symbols: false,
        length: 32,
      }),
    ).toMatch(/^[2-9]{32}$/);
    expect(() =>
      generatePassword({ ...defaultGenerator, length: 7 }),
    ).toThrow();
    expect(() =>
      generatePassword({
        ...defaultGenerator,
        lowercase: false,
        uppercase: false,
        symbols: false,
        digits: false,
      }),
    ).toThrow();
    expect(
      normalizeGenerator({
        length: -1,
        lowercase: false,
        uppercase: false,
        symbols: false,
        digits: false,
      }),
    ).toMatchObject({ length: 20, lowercase: true });
  });
  it("rejects random bytes outside the unbiased range", () => {
    let calls = 0;
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(
      (array: any) => {
        array.fill(calls++ === 0 ? 255 : 0);
        return array;
      },
    );
    expect(
      generatePassword({
        ...defaultGenerator,
        length: 8,
        uppercase: false,
        digits: false,
        symbols: false,
        excludeSimilar: false,
      }),
    ).toBe("aaaaaaaa");
    expect(calls).toBe(2);
  });
});

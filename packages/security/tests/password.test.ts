import { describe, expect, test } from "bun:test";

import { hashPassword, verifyPassword } from "../src/index.ts";

describe("password helpers", () => {
  test("hashes with Argon2id and verifies asynchronously", async () => {
    const hash = await hashPassword("correct horse battery staple", {
      memoryCost: 8,
      timeCost: 1,
    });

    expect(hash).toStartWith("$argon2id$");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(
      true,
    );
    expect(await verifyPassword("incorrect", hash)).toBe(false);
  });

  test("fails closed for malformed input", async () => {
    await expect(hashPassword("")).rejects.toThrow();
    await expect(hashPassword("a".repeat(1_025))).rejects.toThrow();
    expect(await verifyPassword("password", "not-a-hash")).toBe(false);
    expect(await verifyPassword("", "hash")).toBe(false);
  });
});

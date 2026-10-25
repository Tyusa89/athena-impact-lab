import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

describe("sha256Hex", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
    ["a".repeat(1000), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"],
  ])("%j", (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });
  it("matches the platform implementation on assorted inputs (boundary lengths around the 64-byte block)", async () => {
    const { createHash } = await import("node:crypto");
    for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
      const s = "x".repeat(n) + (n % 2 ? "é" : "");
      expect(sha256Hex(s), String(n)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });
});

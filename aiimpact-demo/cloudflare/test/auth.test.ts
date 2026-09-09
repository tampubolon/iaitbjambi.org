import { describe, expect, it } from "vitest";
import { bearer, sign, TokenError, verify } from "../src/auth";

const SECRET = "a-secret-long-enough-for-testing";

describe("sign/verify", () => {
  it("round-trips a code", async () => {
    const now = Date.now();
    expect(await verify(SECRET, await sign(SECRET, "ABCD12", now), now)).toBe("ABCD12");
  });

  it("rejects an expired token", async () => {
    const issued = Date.now() - 13 * 60 * 60 * 1000;
    await expect(verify(SECRET, await sign(SECRET, "ABCD12", issued))).rejects.toThrow(/expired/);
  });

  it("rejects a token signed with another secret", async () => {
    const other = "a-completely-different-secret-xx";
    await expect(verify(SECRET, await sign(other, "ABCD12"))).rejects.toThrow(/signature/);
  });

  it("rejects a payload swapped onto a valid signature", async () => {
    const now = Date.now();
    const mine = await sign(SECRET, "ABCD12", now);
    const other = await sign(SECRET, "ZZZZ99", now);
    const forged = other.slice(0, other.indexOf(".")) + mine.slice(mine.indexOf("."));
    await expect(verify(SECRET, forged, now)).rejects.toThrow(TokenError);
  });

  it.each(["", "nodot", ".", "a.b.c.d"])("rejects malformed %s", async (t) => {
    await expect(verify(SECRET, t)).rejects.toThrow(TokenError);
  });

  it("rejects a secret that is too short", async () => {
    await expect(sign("short", "ABCD12")).rejects.toThrow(TokenError);
  });

  it("survives a code containing a colon", async () => {
    const now = Date.now();
    expect(await verify(SECRET, await sign(SECRET, "AB:CD", now), now)).toBe("AB:CD");
  });
});

describe("bearer", () => {
  it.each([
    ["Bearer abc", "abc"],
    ["bearer abc", "abc"],
    ["BEARER  abc", "abc"],
    ["abc", ""],
    ["", ""],
    ["Bearer", ""],
  ])("%s -> %s", (input, want) => {
    expect(bearer(input)).toBe(want);
  });

  it("handles a missing header", () => {
    expect(bearer(null)).toBe("");
  });
});

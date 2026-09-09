import { describe, expect, it } from "vitest";
import { ALPHABET, CODE_LENGTH, generate, generateMany, normalise, valid } from "../src/code";

describe("alphabet", () => {
  it("omits the characters people misread", () => {
    for (const ch of ["I", "L", "O", "U"]) expect(ALPHABET).not.toContain(ch);
  });

  it("has 32 distinct symbols", () => {
    expect(ALPHABET).toHaveLength(32);
    expect(new Set(ALPHABET).size).toBe(32);
  });
});

describe("generate", () => {
  it("produces a code of the right shape", () => {
    const c = generate();
    expect(c).toHaveLength(CODE_LENGTH);
    expect(valid(c)).toBe(true);
  });

  it("produces distinct codes in bulk", () => {
    const codes = generateMany(500);
    expect(new Set(codes).size).toBe(500);
  });
});

describe("normalise", () => {
  it.each([
    ["abcd12", "ABCD12"],
    ["ABCD-12", "ABCD12"],
    ["ABCD 12", "ABCD12"],
    ["ABCDO2", "ABCD02"], // O read for zero
    ["ABCDI2", "ABCD12"], // I read for one
    ["ABCDL2", "ABCD12"], // L read for one
  ])("%s -> %s", (input, want) => {
    expect(normalise(input)).toBe(want);
  });
});

describe("valid", () => {
  it("accepts a generated code", () => {
    expect(valid(generate())).toBe(true);
  });

  it.each(["", "ABC", "ABCD123", "ABCD!2"])("rejects %s", (input) => {
    expect(valid(input)).toBe(false);
  });
});

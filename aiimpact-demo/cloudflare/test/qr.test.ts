import { describe, expect, it } from "vitest";
import { png, svg } from "../src/qr";
import { hashToken, looksLikeToken } from "../src/ticket";

const URL = "https://tiket.iaitbjambi.org/t/3ZQ8K2M7V4XB9NRTC5WJ0HFDPY";

/** Reads a big-endian uint32 at `at`. */
const u32 = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

describe("png", () => {
  const out = png(URL, 6);

  it("starts with the PNG signature", () => {
    expect([...out.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("declares a square 1-bit greyscale image", () => {
    // IHDR body starts at 16: width, height, depth, colour type.
    expect(u32(out, 16)).toBe(u32(out, 20)); // square
    expect(out[24]).toBe(1); // bit depth — 8 would be eight times the bytes
    expect(out[25]).toBe(0); // colour type 0 = greyscale
  });

  it("ends with IEND", () => {
    expect(new TextDecoder().decode(out.slice(-8, -4))).toBe("IEND");
  });

  it("scales by whole pixels per module, so nothing is resampled", () => {
    // 33 modules + 4 quiet each side = 41; 41 * 6 = 246.
    expect(u32(out, 16) % 6).toBe(0);
  });

  it("stays small enough for a Sheet to fetch two hundred of them", () => {
    expect(out.length).toBeLessThan(20_000);
  });
});

describe("svg", () => {
  const out = svg(URL, 300);

  it("is a self-contained square document", () => {
    expect(out.startsWith("<svg")).toBe(true);
    expect(out).toContain('width="300" height="300"');
    expect(out.endsWith("</svg>")).toBe(true);
  });

  it("draws modules as one path rather than a thousand elements", () => {
    expect((out.match(/<path/g) ?? []).length).toBe(1);
    expect(out).not.toContain("<rect x=");
  });

  it("keeps the quiet zone, without which some readers refuse the code", () => {
    // viewBox is module units: 33 + 4 + 4 = 41.
    expect(out).toContain('viewBox="0 0 41 41"');
  });
});

describe("looksLikeToken", () => {
  it("accepts a 26-character Crockford token", () => {
    expect(looksLikeToken("3ZQ8K2M7V4XB9NRTC5WJ0HFDPY")).toBe(true);
  });

  it("rejects the letters Crockford leaves out, so O/0 and I/1 cannot be confused", () => {
    for (const ch of ["I", "L", "O", "U"]) {
      expect(looksLikeToken(ch + "ZQ8K2M7V4XB9NRTC5WJ0HFDPY")).toBe(false);
    }
  });

  it("rejects wrong lengths", () => {
    expect(looksLikeToken("3ZQ8K2M7V4XB9NRTC5WJ0HFDP")).toBe(false);
    expect(looksLikeToken("3ZQ8K2M7V4XB9NRTC5WJ0HFDPYZ")).toBe(false);
  });
});

describe("hashToken", () => {
  it("is stable, so a ticket keeps working across deploys", async () => {
    expect(await hashToken("abc")).toBe(await hashToken("abc"));
  });

  it("is a SHA-256 hex digest", async () => {
    // Known vector: SHA-256("abc").
    expect(await hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

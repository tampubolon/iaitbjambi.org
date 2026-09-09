import { describe, expect, it } from "vitest";
import { make, MAX_LEN, SlugError, unique } from "../src/slug";

describe("make", () => {
  it.each([
    ["Warung Nasi Goreng Budi", "warung-nasi-goreng-budi"],
    ["  Kopi   Kita  ", "kopi-kita"],
    ["Ayam Geprek 99", "ayam-geprek-99"],
    ["Toko-Bunga_Melati", "toko-bunga-melati"],
    ["Rendang Uni Ana!!!", "rendang-uni-ana"],
    ["Es Teh ☕ Segar", "es-teh-segar"],
    ["CV. Maju Jaya, Tbk", "cv-maju-jaya-tbk"],
  ])("%s -> %s", (input, want) => {
    expect(make(input)).toBe(want);
  });

  it.each(["", "   ", "!!!", "---", "123", "456 789"])("rejects %s", (input) => {
    expect(() => make(input)).toThrow(SlugError);
  });

  it("trims to MAX_LEN without a trailing hyphen", () => {
    const got = make("warung makan sederhana bu ani yang sangat terkenal di jambi");
    expect(got.length).toBeLessThanOrEqual(MAX_LEN);
    expect(got.endsWith("-")).toBe(false);
  });
});

describe("unique", () => {
  it("appends a suffix when taken", async () => {
    const taken = new Set(["kopi-kita", "kopi-kita-2"]);
    expect(await unique("Kopi Kita", async (c) => !taken.has(c))).toBe("kopi-kita-3");
  });

  it("skips reserved labels", async () => {
    expect(await unique("API", async () => true)).toBe("api-2");
  });
});

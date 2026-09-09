import { describe, expect, it } from "vitest";
import { esc, html, page, RenderError, waNumber } from "../src/render";
import type { SiteContent } from "../src/model";

const base: SiteContent = {
  business_name: "Nasi Goreng Budi",
  headline: "Nasi Goreng Budi",
  tagline: "Pedas gurih, porsi besar",
  about: "Warung keluarga sejak 2015.",
  products: [{ name: "Nasi goreng kampung", price: "Rp15.000" }],
  cta_label: "Pesan sekarang",
  wa_number: "0812-3456-7890",
};

describe("waNumber", () => {
  it.each([
    ["081234567890", "6281234567890"],
    ["+62 812-3456-789", "628123456789"],
    ["62812345678", "62812345678"],
    ["0812 3456 7890", "6281234567890"],
    ["812345678", "62812345678"],
    ["", ""],
    ["abc", ""],
  ])("%s -> %s", (input, want) => {
    expect(waNumber(input)).toBe(want);
  });
});

describe("html tagged template", () => {
  it("escapes every interpolation by default", () => {
    expect(html`<p>${"<b>x</b>"}</p>`.toString()).toBe("<p>&lt;b&gt;x&lt;/b&gt;</p>");
  });

  it("escapes quotes so a value cannot break out of an attribute", () => {
    const out = html`<a title="${'" onmouseover="alert(1)'}">x</a>`.toString();
    expect(out).not.toContain('onmouseover="alert(1)"');
    expect(out).toContain("&quot;");
  });

  it("does not double-escape fragments it built itself", () => {
    const inner = html`<b>${"a&b"}</b>`;
    expect(html`<p>${inner}</p>`.toString()).toBe("<p><b>a&amp;b</b></p>");
  });
});

describe("esc", () => {
  it("handles null and undefined without throwing", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
  });
});

/**
 * Design invariant §8.2: nothing a participant or the model supplies may
 * become executable content. Same payloads as the Go render_test.go.
 */
describe("page escapes hostile content", () => {
  const hostile: SiteContent = {
    business_name: "<script>alert(1)</script>",
    headline: 'Warung "><script>alert(2)</script>',
    tagline: "<img src=x onerror=alert(3)>",
    about: "javascript:alert(4)",
    products: [{ name: '<iframe src="evil"></iframe>', price: "<b>Rp1</b>" }],
    cta_label: "</a><script>alert(5)</script>",
    wa_number: "081234567890",
  };

  const out = page(hostile, 2026);

  it.each(["<script", "<img", "<iframe"])("no surviving %s", (tag) => {
    // An "onerror=" left as literal text inside &lt;img …&gt; is inert, so the
    // property that matters is that tag-opening forms do not survive.
    expect(out).not.toContain(tag);
  });

  it("cannot break out of the call-to-action anchor", () => {
    // Testing for the literal "</a><" would match this template's own
    // "</a></div>" and pass or fail for the wrong reason. The real property
    // is that the payload creates no second anchor.
    expect(out.match(/<a\s/g) ?? []).toHaveLength(1);
  });

  it("keeps the payload visible, escaped rather than dropped", () => {
    expect(out).toContain("&lt;script&gt;");
  });

  it("leaves the call to action pointing only at wa.me", () => {
    expect(out).toContain('href="https://wa.me/6281234567890');
  });
});

describe("page", () => {
  it("rejects a number with no digits", () => {
    expect(() => page({ ...base, wa_number: "no digits" }, 2026)).toThrow(RenderError);
  });

  it("omits optional blocks that are absent", () => {
    const out = page({ ...base, address: undefined, hours: undefined }, 2026);
    expect(out).not.toContain('class="meta"');
  });

  it("includes address and hours when present", () => {
    const out = page({ ...base, address: "Jl. Mawar 1", hours: "08.00-20.00" }, 2026);
    expect(out).toContain("Jl. Mawar 1");
    expect(out).toContain("08.00-20.00");
  });
});

/**
 * The model writes the page, so this module decides what untrusted markup
 * reaches the organisation's domain. These run in the Workers runtime because
 * HTMLRewriter only exists there — testing a node stand-in would test a
 * different implementation than the one that ships.
 */
import { describe, expect, it } from "vitest";
import { safeUrl, sanitize, SanitizeError, waNumber } from "../src/sanitize";

/**
 * Counts elements of a given tag by re-parsing the output.
 *
 * This is the property that actually matters. Asserting the substring
 * "<script" is absent is weaker and sometimes wrong: malformed input like
 * `<scr<script>ipt>` passes through as raw text, so the characters survive
 * while no script element is ever created. A browser parses it the same way
 * and executes nothing — and the CSP in index.ts refuses scripts regardless.
 */
async function countElements(html: string, tag: string): Promise<number> {
  let n = 0;
  const r = new HTMLRewriter().on(tag, { element: () => void n++ });
  await r.transform(new Response(html)).text();
  return n;
}

/** Wraps a fragment in a document carrying a valid WhatsApp link. */
function doc(body: string, title = "Warung Budi"): string {
  return `<!doctype html><html lang="id"><head><title>${title}</title></head>
<body>${body}<a href="https://wa.me/6281234567890">Pesan</a></body></html>`;
}

describe("waNumber", () => {
  it.each([
    ["081234567890", "6281234567890"],
    ["+62 812-3456-789", "628123456789"],
    ["62812345678", "62812345678"],
    ["", ""],
    ["abc", ""],
  ])("%s -> %s", (input, want) => {
    expect(waNumber(input)).toBe(want);
  });
});

describe("safeUrl", () => {
  it.each([
    "https://wa.me/628123",
    "http://example.com",
    "mailto:a@b.c",
    "tel:+62812",
    "#section",
    "/relative",
  ])("allows %s", (u) => expect(safeUrl(u)).toBe(true));

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox",
    "file:///etc/passwd",
    "blob:https://x",
    "",
  ])("rejects %s", (u) => expect(safeUrl(u)).toBe(false));

  it("rejects schemes hidden with control characters", () => {
    // "java\tscript:" and "java\nscript:" parse as javascript: in some
    // browsers, which is why control characters are stripped before matching.
    expect(safeUrl("java\tscript:alert(1)")).toBe(false);
    expect(safeUrl("java\nscript:alert(1)")).toBe(false);
    expect(safeUrl(" javascript:alert(1)")).toBe(false);
  });
});

describe("sanitize removes what cannot be allowed to run", () => {
  it("drops script elements", async () => {
    const { html } = await sanitize(doc(`<script>alert(1)</script><p>hi</p>`));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("<p>hi</p>");
  });

  it("drops event handler attributes however they are cased", async () => {
    const { html } = await sanitize(
      doc(`<div onclick="a()" ONMOUSEOVER="b()" onError="c()">x</div>`),
    );
    expect(html.toLowerCase()).not.toContain("onclick");
    expect(html.toLowerCase()).not.toContain("onmouseover");
    expect(html.toLowerCase()).not.toContain("onerror");
    expect(html).toContain("x");
  });

  it("drops javascript: and data: URLs but keeps the element", async () => {
    const { html } = await sanitize(
      doc(`<a href="javascript:alert(1)">klik</a><img src="data:text/html,x">`),
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).toContain("klik");
  });

  it.each(["iframe", "object", "embed", "form", "input", "textarea", "noscript", "base"])(
    "drops <%s>",
    async (tag) => {
      const { html } = await sanitize(doc(`<${tag}>trapped</${tag}>`));
      expect(html).not.toContain(`<${tag}`);
    },
  );

  it("drops srcdoc, which smuggles a whole document", async () => {
    const { html } = await sanitize(doc(`<div srcdoc="<script>alert(1)</script>">x</div>`));
    expect(html).not.toContain("srcdoc");
  });

  it("drops meta refresh redirects", async () => {
    const { html } = await sanitize(
      `<!doctype html><html><head><title>X</title>
       <meta http-equiv="refresh" content="0;url=https://evil.test"></head>
       <body><a href="https://wa.me/628123">p</a></body></html>`,
    );
    expect(html).not.toContain("http-equiv");
  });

  it("survives malformed markup, which is where regex sanitisers fail", async () => {
    // Split-tag nesting and an unquoted attribute value: both defeat naive
    // string replacement. The nesting trick leaves its characters in the
    // output as inert text, so assert on elements rather than substrings.
    const { html } = await sanitize(
      doc(`<scr<script>ipt>alert(1)</script><div onclick=a() >x</div>`),
    );
    expect(await countElements(html, "script")).toBe(0);
    expect(html.toLowerCase()).not.toContain("onclick");
    expect(html).toContain("x");
  });

  it("produces no script element from any of the usual bypasses", async () => {
    const payloads = [
      `<script>alert(1)</script>`,
      `<SCRIPT>alert(1)</SCRIPT>`,
      `<script src="https://evil.test/x.js"></script>`,
      `<scr<script>ipt>alert(1)</script>`,
      `<svg><script>alert(1)</script></svg>`,
      `<div><script defer>alert(1)</script></div>`,
    ];
    for (const p of payloads) {
      const { html } = await sanitize(doc(p));
      expect(await countElements(html, "script"), p).toBe(0);
    }
  });

  it("fails safely when unterminated markup swallows the WhatsApp link", async () => {
    // An unclosed tag consumes everything after it, so the link never becomes
    // an element. The participant gets an actionable message and retries --
    // which is the right outcome: publishing a page whose only button is gone
    // would be worse than refusing it.
    await expect(sanitize(doc(`<div>x</div`))).rejects.toThrow(SanitizeError);
  });
});

describe("sanitize keeps what makes the page the participant's own", () => {
  it("preserves layout, styles and content", async () => {
    const { html } = await sanitize(
      `<!doctype html><html lang="id"><head><title>Kopi Kita</title>
       <style>body{background:#0b3d2e;color:#fff;font-family:Georgia,serif}</style></head>
       <body><header><h1>Kopi Kita</h1></header>
       <section class="menu"><ul><li>Kopi susu <b>Rp12.000</b></li></ul></section>
       <a class="cta" href="https://wa.me/6281234567890">Pesan via WhatsApp</a></body></html>`,
    );
    expect(html).toContain("#0b3d2e");
    expect(html).toContain("Georgia,serif");
    expect(html).toContain("<h1>Kopi Kita</h1>");
    expect(html).toContain("Rp12.000");
    expect(html).toContain('class="cta"');
  });

  it("returns the title, which the slug is derived from", async () => {
    const { title } = await sanitize(doc("<p>x</p>", "  Warung   Nasi  Goreng Budi  "));
    expect(title).toBe("Warung Nasi Goreng Budi");
  });
});

describe("sanitize repairs the WhatsApp link", () => {
  it("rewrites a local-format number to country code", async () => {
    // The model is told to do this and usually does. When it does not, the
    // button silently opens nothing and the participant only finds out when a
    // customer tells them.
    const { html, wa } = await sanitize(
      `<!doctype html><html><head><title>X</title></head>
       <body><a href="https://wa.me/081234567890">Pesan</a></body></html>`,
    );
    expect(wa).toBe("6281234567890");
    expect(html).toContain("https://wa.me/6281234567890");
    expect(html).not.toContain("wa.me/0812");
  });

  it("keeps the prefilled message query intact", async () => {
    const { html } = await sanitize(
      `<!doctype html><html><head><title>X</title></head>
       <body><a href="https://wa.me/08123?text=Halo">Pesan</a></body></html>`,
    );
    expect(html).toContain("https://wa.me/628123?text=Halo");
  });

  it("rejects a page with no WhatsApp link at all", async () => {
    await expect(
      sanitize(`<!doctype html><html><head><title>X</title></head><body><p>hi</p></body></html>`),
    ).rejects.toThrow(SanitizeError);
  });
});

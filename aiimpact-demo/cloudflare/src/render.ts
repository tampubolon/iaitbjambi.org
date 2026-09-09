/**
 * Turns model output into a finished page.
 *
 * The Go version of this used html/template, whose contextual auto-escaping
 * made design invariant §8.2 a property of the standard library. JavaScript
 * has no equivalent, so the guarantee is rebuilt here from two rules:
 *
 *   1. `html` is a tagged template that escapes EVERY interpolation. Escaping
 *      is therefore the default and cannot be forgotten -- the failure mode of
 *      hand-written concatenation is that one insertion point gets missed, and
 *      one is enough.
 *   2. Every attribute in the template below is quoted. Escaping &<>"' is
 *      sufficient for text and quoted-attribute contexts; it is NOT sufficient
 *      for unquoted attributes, so unquoted attributes are prohibited here.
 *
 * The model never supplies a URL, a style, or a script -- the only dynamic URL
 * is built from digits extracted by `waNumber`, so URL injection is impossible
 * by construction rather than by filtering.
 *
 * `render.test.ts` asserts these properties against the same adversarial
 * payloads the Go tests used.
 */
import type { SiteContent } from "./model";

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes a value for HTML text and quoted-attribute contexts. */
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

/** Marker for a fragment this module built itself and must not re-escape. */
class Safe {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Wraps a fragment produced by this module. Never call with untrusted input. */
function safe(s: string): Safe {
  return new Safe(s);
}

/** Tagged template that escapes every interpolation unless already Safe. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Safe {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out += (v instanceof Safe ? v.value : esc(v)) + (strings[i + 1] ?? "");
  }
  return safe(out);
}

/** Joins fragments this module built. */
function join(parts: Safe[]): Safe {
  return safe(parts.map((p) => p.value).join(""));
}

/**
 * Converts an Indonesian number to the wa.me form.
 *
 * Local format is what people write (0812…) and what wa.me rejects; it needs
 * the country code (62812…). Getting this wrong yields a button that silently
 * opens nothing -- the most common failure in this workflow.
 */
export function waNumber(raw: string): string {
  const n = String(raw ?? "").replace(/\D/g, "");
  if (!n) return "";
  if (n.startsWith("62")) return n;
  if (n.startsWith("0")) return "62" + n.slice(1);
  return "62" + n;
}

export class RenderError extends Error {}

/** Renders content to a complete standalone HTML document. */
export function page(c: SiteContent, year: number): string {
  const wa = waNumber(c.wa_number);
  if (!wa) {
    throw new RenderError(`no usable WhatsApp number in ${JSON.stringify(c.wa_number)}`);
  }
  // Built from digits only, then encoded -- nothing from the model reaches it.
  const link = `https://wa.me/${wa}?text=${encodeURIComponent("Halo, saya ingin memesan.")}`;

  const products = (c.products ?? []).map(
    (p) => html`<li><span class="name">${p.name}${p.note ? html`<span class="note">${p.note}</span>` : ""}</span><span class="price">${p.price}</span></li>`,
  );

  return html`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${c.business_name}</title>
<meta name="description" content="${c.tagline}">
<meta property="og:title" content="${c.business_name}">
<meta property="og:description" content="${c.tagline}">
<style>
:root{--ink:#14181f;--muted:#5d6674;--line:#e2e6ec;--bg:#fbfbf9;--accent:#12694a;--card:#fff}
@media(prefers-color-scheme:dark){:root{--ink:#eef1f5;--muted:#98a2b3;--line:#27303c;--bg:#0e1218;--accent:#4fbf8e;--card:#151b23}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:28px 20px 96px}
header{padding:8px 0 24px;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:clamp(28px,7vw,38px);line-height:1.15;letter-spacing:-.02em}
.tagline{margin:10px 0 0;color:var(--muted);font-size:17px}
.about{margin:22px 0 0}
h2{margin:34px 0 12px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
ul{list-style:none;margin:0;padding:0}
li{display:flex;justify-content:space-between;gap:16px;align-items:baseline;padding:14px 0;border-bottom:1px solid var(--line)}
li:last-child{border-bottom:0}
.name{font-weight:600}
.note{display:block;color:var(--muted);font-size:14px;font-weight:400;margin-top:2px}
.price{white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--accent);font-weight:600}
.meta{margin:26px 0 0;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:15px}
.meta div+div{margin-top:6px}
.cta{position:fixed;left:0;right:0;bottom:0;padding:12px 20px calc(12px + env(safe-area-inset-bottom));background:var(--bg);border-top:1px solid var(--line)}
.cta a{display:block;max-width:520px;margin:0 auto;background:var(--accent);color:#fff;text-align:center;text-decoration:none;font-weight:600;padding:15px;border-radius:10px}
footer{margin-top:28px;color:var(--muted);font-size:12.5px;text-align:center}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${c.headline}</h1>
    ${c.tagline ? html`<p class="tagline">${c.tagline}</p>` : ""}
  </header>
  ${c.about ? html`<p class="about">${c.about}</p>` : ""}
  ${products.length ? html`<h2>Menu &amp; Harga</h2><ul>${join(products)}</ul>` : ""}
  ${
    c.address || c.hours
      ? html`<div class="meta">${c.address ? html`<div>${c.address}</div>` : ""}${c.hours ? html`<div>${c.hours}</div>` : ""}</div>`
      : ""
  }
  <footer>${c.business_name} &middot; ${year}<br>Dibuat di AIMPACT bersama IA-ITB Pengda Jambi</footer>
</div>
<div class="cta"><a href="${link}" rel="noopener">${c.cta_label || "Pesan via WhatsApp"}</a></div>
</body>
</html>
`.value;
}

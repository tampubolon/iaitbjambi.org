/**
 * Issues tickets and lab accounts from the participant list.
 *
 *   node --experimental-strip-types issue.mjs Daftar-Peserta.csv
 *
 * One code per participant, used for three things: opening their ticket, being
 * admitted at the door, and signing in to the builder. Their landing page is
 * fixed in advance at <nama>.iaitbjambi.org rather than derived from whatever
 * the model titles the page, so the address can be printed on the slip and
 * handed out before anyone has generated anything.
 *
 * Writes into ./out:
 *
 *   participants.sql   D1: the lab accounts, with slugs pre-assigned
 *   tickets.json       Supabase: load with `node load-tickets.mjs`
 *   distribusi.csv     the Google Sheets distribution list (PRD F11)
 *   cetak.html         printable slips, 8 per A4 page
 *   tokens.txt         plaintext tokens, for re-issuing a lost export
 *
 * Runs locally rather than behind an admin UI: it happens once, and the
 * validation matters more than the interface. The consequence to know is that
 * this is the ONLY moment the plaintext ticket tokens exist - the database
 * stores their hashes, so losing out/ means re-issuing, not recovering.
 *
 * Re-running generates NEW codes and invalidates everything already sent. It
 * refuses to overwrite out/ for that reason.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { svg } from "./src/qr.ts";

const DOMAIN = "iaitbjambi.org";
const EVENT = { name: "AIMPACT - AI untuk UMKM", date: "17 September 2026", place: "Kota Jambi" };

/** Labels that must never become a participant's site. Mirrors src/slug.ts. */
const RESERVED = new Set([
  "aimpact", "tiket", "www", "api", "mail", "ftp", "admin", "cdn", "smtp",
  "imap", "app", "test", "staging", "dev", "static", "assets",
]);

// Crockford base32: no I, L, O or U, so nothing reads as 1 or 0 when a
// participant squints at a printed slip or a volunteer types it at the door.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 6; // must match CODE_LENGTH in src/code.ts

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sql = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** 26 chars x 5 bits = 130 bits, over the 128 the PRD asks of the QR token. */
function token(len = 26) {
  return [...randomBytes(len)].map((b) => ALPHABET[b % 32]).join("");
}

/** Uniform over the alphabet - randomInt avoids the modulo bias of % 32. */
function code() {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

/**
 * Builds the participant's site label from their name.
 *
 * At most three parts, so "Nyimas Rizki Nawal Fitria" becomes
 * nyimas-rizki-nawal rather than a label nobody can read out across a noisy
 * room. Accents are stripped rather than transliterated.
 */
function slugify(name, maxParts = 3) {
  const parts = String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[\s\-_./,]+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
  return parts.slice(0, maxParts).join("-");
}

/**
 * Normalises an Indonesian mobile number to the 62XXXXXXXXXX wa.me wants.
 * Returns null when it cannot be made into one - including when it is blank,
 * which is expected for the reserved seats that have no phone yet.
 */
function normaliseWa(raw) {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return null;
  const n = d.startsWith("0") ? "62" + d.slice(1)
          : d.startsWith("8") ? "62" + d
          : d.startsWith("62") ? d
          : null;
  return n && n.length >= 11 && n.length <= 15 ? n : null;
}

/** CSV reader handling quotes, embedded separators and doubled quotes. */
function parseCsv(text, sep) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// --- read --------------------------------------------------------------

const input = process.argv[2];
if (!input) {
  console.error("usage: node --experimental-strip-types issue.mjs <peserta.csv>");
  process.exit(2);
}
if (existsSync("out")) {
  console.error(
    "out/ already exists.\n" +
    "Re-issuing generates new codes and invalidates every ticket already sent.\n" +
    "Move or delete out/ first if that is really what you want.",
  );
  process.exit(2);
}

// The export is Latin-1; reading it as UTF-8 mangles the names with accents.
const raw = readFileSync(input);
const text = raw.includes(0xef) && raw.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
  ? raw.toString("utf8")
  : raw.toString("latin1");
const sep = (text.match(/;/g)?.length ?? 0) > (text.match(/,/g)?.length ?? 0) ? ";" : ",";

const all = parseCsv(text, sep).filter((r) => r.some((f) => f.trim()));

// The real header is not necessarily the first line - this export carries a
// note above it. Find the row that names the columns.
const headerAt = all.findIndex((r) => r.some((f) => /^\s*nama/i.test(f)));
if (headerAt === -1) {
  console.error("could not find a header row containing a 'Nama' column");
  process.exit(2);
}
const header = all[headerAt].map((h) => h.trim().toLowerCase());
const col = (...names) => header.findIndex((h) => names.some((n) => h.startsWith(n)));
const iName = col("nama");
const iWa = col("kontak", "whatsapp", "wa", "nomor", "hp", "telepon");
if (iName === -1) { console.error("no name column"); process.exit(2); }

const rows = all.slice(headerAt + 1);

// --- validate ----------------------------------------------------------

const good = [], bad = [], seenSlug = new Map(), seenWa = new Map();
for (const [n, r] of rows.entries()) {
  const line = headerAt + n + 2;
  const name = (r[iName] ?? "").trim();
  if (!name) continue; // blank filler row

  const wa = iWa === -1 ? null : normaliseWa(r[iWa]);
  let label = slugify(name);
  if (!label || !/[a-z]/.test(label)) {
    bad.push({ line, name, why: "nama tidak menghasilkan alamat yang bisa dipakai" });
    continue;
  }
  if (RESERVED.has(label)) label = `${label}-peserta`;

  // Names in this list are unique, but a suffix costs less than an outage if
  // a later list repeats one.
  if (seenSlug.has(label)) {
    let i = 2;
    while (seenSlug.has(`${label}-${i}`)) i++;
    label = `${label}-${i}`;
  }
  seenSlug.set(label, line);

  if (wa && seenWa.has(wa)) {
    bad.push({ line, name, why: `nomor sama dengan baris ${seenWa.get(wa)}` });
    continue;
  }
  if (wa) seenWa.set(wa, line);

  good.push({ name, wa, slug: label });
}

console.log(`  ${good.length} peserta diterima, ${bad.length} ditolak`);
for (const b of bad) console.log(`    baris ${b.line}: ${b.why}  [${b.name}]`);
const noPhone = good.filter((p) => !p.wa);
if (noPhone.length) {
  console.log(`\n  ${noPhone.length} tanpa nomor WhatsApp - tiket tetap dibuat, serahkan manual:`);
  console.log(`    ${noPhone.map((p) => p.name).join(", ")}`);
}
if (!good.length) process.exit(2);

// --- issue -------------------------------------------------------------

const used = new Set();
const issued = good.map((p) => {
  let c = code();
  while (used.has(c)) c = code();
  used.add(c);
  const tok = token();
  return {
    ...p,
    code: c,
    ticket_id: `tk_${token(12).toLowerCase()}`,
    tok,
    hash: sha256(tok),
    url: `https://tiket.${DOMAIN}/t/${tok}`,
    site: `https://${p.slug}.${DOMAIN}`,
  };
});

mkdirSync("out", { recursive: true });

// D1: the lab accounts. The slug is set now, so resolveSlug() in the consumer
// finds it already claimed and the participant's address never depends on what
// the model decided to call their business.
writeFileSync(
  "out/participants.sql",
  "-- Generated by issue.mjs. Replaces every existing lab account.\n" +
  "DELETE FROM jobs;\nDELETE FROM pages;\nDELETE FROM participants;\n" +
  issued
    .map((t) =>
      `INSERT INTO participants (code, slug, business_name) VALUES ` +
      `(${sql(t.code)}, ${sql(t.slug)}, ${sql(t.name)});`,
    )
    .join("\n") + "\n",
);

// Supabase: loaded over PostgREST, because the direct Postgres host is
// IPv6-only and not reliably reachable from here.
writeFileSync(
  "out/tickets.json",
  JSON.stringify(
    issued.map((t) => ({
      ticket_id: t.ticket_id,
      name: t.name,
      wa_number: t.wa ?? "-",
      token_hash: t.hash,
      manual_code: t.code,
      builder_code: t.code,
      is_staff: false,
    })),
    null,
    2,
  ),
);

const message = (t) =>
  `Halo ${t.name}, Anda terpilih mengikuti ${EVENT.name}, ${EVENT.date} di ${EVENT.place}. ` +
  `Tiket: ${t.url} Simpan gambar QR dan siapkan saat registrasi. ` +
  `Kode Anda: ${t.code} (untuk registrasi dan untuk membuat website). ` +
  `Website Anda nanti: ${t.site}. Tiket hanya untuk Anda.`;

const cell = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
writeFileSync(
  "out/distribusi.csv",
  ["Nama,Nomor WhatsApp,Kode,Link tiket,URL PNG QR,QR,Website peserta,Pesan WhatsApp,Kirim WA,Status pengiriman,Petugas,Waktu kirim"]
    .concat(
      issued.map((t, i) => {
        const row = i + 2;
        return [
          cell(t.name),
          cell(t.wa ?? ""),
          cell(t.code),
          cell(t.url),
          cell(`https://tiket.${DOMAIN}/qr/${t.tok}.png`),
          cell(`=IMAGE(E${row},4,140,140)`),
          cell(t.site),
          cell(message(t)),
          cell(t.wa ? `=HYPERLINK("https://wa.me/"&B${row}&"?text="&ENCODEURL(H${row}),"Kirim WA")` : ""),
          cell(t.wa ? "Belum dikirim" : "Tanpa nomor - serahkan manual"),
          "",
          "",
        ].join(",");
      }),
    )
    .join("\n") + "\n",
);

writeFileSync(
  "out/tokens.txt",
  "# Plaintext ticket tokens and lab codes. The database holds only hashes of\n" +
  "# the tokens. Treat as credentials.\n" +
  issued.map((t) => `${t.code}\t${t.name}\t${t.site}\t${t.url}`).join("\n") + "\n",
);

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const slip = (t) => `
  <div class="slip">
    <div class="qr">${svg(t.url, 150)}</div>
    <div class="txt">
      <div class="ev">${esc(EVENT.name)}</div>
      <div class="nm">${esc(t.name)}</div>
      <div class="dt">${EVENT.date} &middot; ${EVENT.place}</div>
      <div class="lbl">Kode registrasi &amp; AIMPACT</div>
      <div class="cd">${t.code}</div>
      <div class="lbl">Website Anda</div>
      <div class="site">${esc(t.slug)}.${DOMAIN}</div>
    </div>
  </div>`;

writeFileSync(
  "out/cetak.html",
  `<!doctype html><meta charset="utf-8"><title>Tiket AIMPACT</title><style>
  @page{size:A4;margin:8mm}
  body{font:12px/1.35 system-ui,sans-serif;margin:0}
  .sheet{display:grid;grid-template-columns:1fr 1fr}
  .slip{display:flex;gap:9px;align-items:center;padding:6mm 5mm;height:34mm;
        border:1px dashed #bbb;break-inside:avoid}
  .qr{width:27mm;flex:none}.qr svg{display:block;width:100%;height:auto}
  .txt{min-width:0}
  .ev{font-size:8px;letter-spacing:.07em;text-transform:uppercase;color:#666}
  .nm{font-size:14px;font-weight:700;line-height:1.15;margin:1px 0}
  .dt{font-size:9px;color:#666}
  .lbl{font-size:7.5px;letter-spacing:.06em;text-transform:uppercase;color:#888;margin-top:4px}
  .cd{font:700 19px ui-monospace,monospace;letter-spacing:.16em}
  .site{font:600 9.5px ui-monospace,monospace;color:#12507e;word-break:break-all}
  @media print{.slip{border-color:#ddd}}
  </style><div class="sheet">${issued.map(slip).join("")}</div>`,
);

console.log(`
  out/participants.sql  ${issued.length} lab accounts
  out/tickets.json      ${issued.length} tickets -> node load-tickets.mjs
  out/distribusi.csv    import to Google Sheets (formulas in F and I)
  out/cetak.html        open and print (8 slips per A4 page)
  out/tokens.txt        KEEP PRIVATE

  Note: the "Panitia" labels on /admin/peserta are stored in Supabase
  settings.panitia_codes and refer to codes. Re-issuing mints new codes, so
  that list must be updated afterwards or every row reads "Peserta".
`);

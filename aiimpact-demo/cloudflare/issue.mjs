/**
 * Issues tickets from a participant list.
 *
 *   node --experimental-strip-types issue.mjs peserta.csv
 *
 * Input CSV needs a name column and a WhatsApp column; `nama`/`name` and
 * `whatsapp`/`wa`/`nomor`/`phone` are all recognised, in any order.
 *
 * Writes four files into ./out:
 *
 *   tickets.sql        apply with: npm run db:tickets
 *   distribusi.csv     the Google Sheets distribution list (PRD F11)
 *   cetak.html         220 printable slips, one page per 8
 *   tokens.txt         plaintext tokens, for re-issuing a lost export
 *
 * Runs locally rather than behind an admin UI because there is no time to
 * build one and no second event to reuse it for. The consequence to know:
 * this is the ONLY moment the plaintext tokens exist. The database stores
 * their hashes, so losing out/ means re-issuing tickets, not recovering them.
 *
 * Re-running generates NEW tokens and invalidates whatever was already sent.
 * It refuses to overwrite out/ for that reason.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { svg } from "./src/qr.ts";

const DOMAIN = "iaitbjambi.org";
const EVENT = { name: "AIMPACT — AI untuk UMKM", date: "17 September 2026", place: "Kota Jambi" };

// Crockford base32: no I, L, O or U, so nothing reads as 1/0 when a participant
// is squinting at a printed slip or a volunteer is typing it at the door.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 26 chars x 5 bits = 130 bits, comfortably over the 128 the PRD asks for. */
function token(len = 26) {
  const bytes = randomBytes(len);
  return [...bytes].map((b) => ALPHABET[b % 32]).join("");
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sql = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Normalises an Indonesian mobile number to the 62XXXXXXXXXX that wa.me wants.
 * Returns null when it cannot be made into one, so the row is flagged rather
 * than silently sent to a wrong number.
 */
function normaliseWa(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  let n = digits;
  if (n.startsWith("0")) n = "62" + n.slice(1);
  else if (n.startsWith("8")) n = "62" + n;
  else if (!n.startsWith("62")) return null;
  // Indonesian mobiles are 62 + 9..13 digits.
  return n.length >= 11 && n.length <= 15 ? n : null;
}

/** Minimal CSV reader: quoted fields, embedded commas and doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

function pick(header, names) {
  const i = header.findIndex((h) => names.includes(h.trim().toLowerCase()));
  return i === -1 ? null : i;
}

// --- read and validate -------------------------------------------------

const input = process.argv[2];
if (!input) {
  console.error("usage: node --experimental-strip-types issue.mjs <peserta.csv>");
  process.exit(2);
}
if (existsSync("out")) {
  console.error(
    "out/ already exists.\n" +
    "Re-issuing generates new tokens and invalidates every ticket already sent.\n" +
    "Move or delete out/ first if that is really what you want.",
  );
  process.exit(2);
}

const rows = parseCsv(readFileSync(input, "utf8"));
const header = rows.shift() ?? [];
const iName = pick(header, ["nama", "name", "nama peserta"]);
const iWa = pick(header, ["whatsapp", "wa", "nomor", "nomor whatsapp", "phone", "hp"]);
if (iName === null || iWa === null) {
  console.error(`could not find name and WhatsApp columns in: ${header.join(", ")}`);
  process.exit(2);
}

// Builder codes, so a ticket can carry the participant's AIMPACT access.
// Optional: without the seed file tickets still issue, just unlinked.
let builderCodes = [];
try {
  const seed = parseCsv(readFileSync("seed/participant-codes.csv", "utf8"));
  seed.shift();
  builderCodes = seed.map((r) => r[0]);
} catch {
  console.warn("  (no seed/participant-codes.csv — tickets will not carry builder access)");
}

const good = [], bad = [], seenWa = new Map();
for (const [n, r] of rows.entries()) {
  const name = (r[iName] ?? "").trim();
  const wa = normaliseWa(r[iWa]);
  const line = n + 2;
  if (!name) { bad.push({ line, why: "nama kosong", raw: r.join(",") }); continue; }
  if (!wa) { bad.push({ line, why: `nomor tidak valid: ${r[iWa]}`, raw: name }); continue; }
  if (seenWa.has(wa)) {
    bad.push({ line, why: `duplikat nomor (sama dengan baris ${seenWa.get(wa)})`, raw: name });
    continue;
  }
  seenWa.set(wa, line);
  good.push({ name, wa });
}

console.log(`  ${good.length} peserta valid, ${bad.length} ditolak`);
for (const b of bad) console.log(`    baris ${b.line}: ${b.why}  [${b.raw}]`);
if (good.length > 200) {
  console.error(`\n  ${good.length} exceeds the 200-ticket cap; trim the list first.`);
  process.exit(2);
}
if (!good.length) process.exit(2);

// --- issue -------------------------------------------------------------

const issued = good.map((p, i) => {
  const tok = token();
  return {
    ...p,
    ticket_id: `tk_${token(12).toLowerCase()}`,
    tok,
    hash: sha256(tok),
    // One code for both doors: the participant types this at registration if
    // the camera fails, and again at the builder. Two codes on one slip was a
    // question the desk would have had to answer 200 times.
    manual: builderCodes[i] ?? token(10),
    builder: builderCodes[i] ?? null,
    url: `https://tiket.${DOMAIN}/t/${tok}`,
  };
});

mkdirSync("out", { recursive: true });

writeFileSync(
  "out/tickets.sql",
  "-- Generated by issue.mjs. Applying this replaces any existing ticket set.\n" +
  "DELETE FROM check_ins;\nDELETE FROM tickets;\n" +
  issued
    .map((t) =>
      `INSERT INTO tickets (ticket_id, name, wa_number, token_hash, manual_code, builder_code) ` +
      `VALUES (${sql(t.ticket_id)}, ${sql(t.name)}, ${sql(t.wa)}, ${sql(t.hash)}, ` +
      `${sql(t.manual)}, ${t.builder ? sql(t.builder) : "NULL"});`,
    )
    .join("\n") + "\n",
);

const message = (t) =>
  `Halo ${t.name}, Anda terpilih mengikuti ${EVENT.name}, ${EVENT.date} di ${EVENT.place}. ` +
  `Tiket: ${t.url} Simpan gambar QR dan siapkan saat registrasi. ` +
  `Kode Anda: ${t.manual} (untuk registrasi dan untuk membuat website). ` +
  `Tiket hanya untuk Anda.`;

const csvCell = (s) => `"${String(s).replace(/"/g, '""')}"`;
writeFileSync(
  "out/distribusi.csv",
  ["Nama,Nomor WhatsApp,Kode tiket,Link tiket,URL PNG QR,QR,Pesan WhatsApp,Kirim WA,Status pengiriman,Petugas,Waktu kirim"]
    .concat(
      issued.map((t, i) => {
        const row = i + 2;
        return [
          csvCell(t.name),
          csvCell(t.wa),
          csvCell(t.manual),
          csvCell(t.url),
          csvCell(`https://tiket.${DOMAIN}/qr/${t.tok}.png`),
          csvCell(`=IMAGE(E${row},4,140,140)`),
          csvCell(message(t)),
          csvCell(`=HYPERLINK("https://wa.me/"&B${row}&"?text="&ENCODEURL(G${row}),"Kirim WA")`),
          csvCell("Belum dikirim"),
          "",
          "",
        ].join(",");
      }),
    )
    .join("\n") + "\n",
);

writeFileSync(
  "out/tokens.txt",
  "# Plaintext tokens. The database holds only their hashes.\n" +
  "# Treat as credentials: anyone with a token can open that ticket.\n" +
  issued.map((t) => `${t.manual}\t${t.name}\t${t.url}`).join("\n") + "\n",
);

// Printed slips. 8 to an A4 page, cut lines between, QR big enough to scan
// off paper as well as off a phone.
// Two codes, and they do different jobs — the top one gets you through the
// door, the bottom one builds your page. They are labelled rather than merely
// printed, because an unlabelled pair of codes is a queue-forming question.
const slip = (t) => `
  <div class="slip">
    <div class="qr">${svg(t.url, 150)}</div>
    <div class="txt">
      <div class="ev">${EVENT.name}</div>
      <div class="nm">${t.name.replace(/[&<>]/g, "")}</div>
      <div class="dt">${EVENT.date} · ${EVENT.place}</div>
      <div class="lbl">Kode registrasi &amp; AIMPACT</div>
      <div class="cd">${t.manual}</div>
      <div class="note">aimpact.iaitbjambi.org</div>
    </div>
  </div>`;

writeFileSync(
  "out/cetak.html",
  `<!doctype html><meta charset="utf-8"><title>Tiket AIMPACT</title><style>
  @page{size:A4;margin:10mm}
  body{font:12px/1.35 system-ui,sans-serif;margin:0}
  .sheet{display:grid;grid-template-columns:1fr 1fr;gap:0}
  .slip{display:flex;gap:10px;align-items:center;padding:8mm 6mm;height:36mm;
        border:1px dashed #bbb;break-inside:avoid}
  .qr{width:30mm;flex:none}.qr svg{display:block;width:100%;height:auto}
  .ev{font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:#555}
  .nm{font-size:15px;font-weight:700;line-height:1.15;margin:2px 0}
  .dt{font-size:10px;color:#555}
  .lbl{font-size:8px;letter-spacing:.06em;text-transform:uppercase;color:#777;margin-top:5px}
  .cd{font:700 20px ui-monospace,monospace;letter-spacing:.16em}
  .note{font-size:9px;color:#777;margin-top:2px}
  @media print{.slip{border-color:#ddd}}
  </style><div class="sheet">${issued.map(slip).join("")}</div>`,
);

console.log(`
  out/tickets.sql      ${issued.length} tickets -> npm run db:tickets
  out/distribusi.csv   import to Google Sheets (formulas in columns F and H)
  out/cetak.html       open and print (8 slips per A4 page)
  out/tokens.txt       KEEP PRIVATE - the only copy of the plaintext tokens
`);

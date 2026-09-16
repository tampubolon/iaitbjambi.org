/**
 * Admin pages — tiket.<domain>/admin.
 *
 * The things that previously needed a terminal and me in it: find a
 * participant, revoke a leaked ticket, correct a check-in someone made by
 * mistake, export the attendance list. PRD s3 roles, F09 and F10.
 *
 * Participant import is deliberately NOT here. It happens once, before the
 * event, and issue.mjs already does it with validation and a preview — a
 * browser upload would be a second implementation of the same thing, built in
 * a hurry, for a job that happens once.
 *
 * Every write records who did it and why. The reason is required by the
 * database, not by this form, so it cannot be skipped by posting directly.
 */
import type { Env } from "./model";
import * as assessment from "./assessment";
import { Store } from "./store";
import * as tickets from "./ticket";

/** Renders a value for a CSV cell, quoting and escaping as needed. */
function csvCell(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function attendanceCsv(rows: tickets.Found[], wib: (s: string) => string): string {
  const header = "Nama,Nomor WhatsApp,Kode,Status,Hadir,Waktu hadir,Dicatat oleh";
  const body = rows.map((r) =>
    [
      csvCell(r.name),
      csvCell(r.wa_number),
      csvCell(r.manual_code),
      csvCell(r.status === "active" ? "aktif" : "dibatalkan"),
      csvCell(r.checked_at ? "ya" : "tidak"),
      csvCell(r.checked_at ? wib(r.checked_at) : ""),
      csvCell(r.checked_by ?? ""),
    ].join(","),
  );
  return [header, ...body].join("\n") + "\n";
}

interface Ctx {
  esc: (s: string) => string;
  wib: (s: string) => string;
  page: (title: string, body: string, extraHead?: string) => Response;
  /** Issues the role-bound admin session cookie; tiket.ts owns the format. */
  cookie: (env: Env, name: string) => Promise<string>;
}

export function signInPage(c: Ctx, message = ""): Response {
  return c.page(
    "Masuk admin",
    `<div class="wrap"><div class="card">
      <h1>Masuk admin</h1>
      <p class="meta">Halaman panitia inti. Petugas scan tidak perlu masuk di sini.</p>
      ${message ? `<div class="res bad"><b>Gagal</b>${c.esc(message)}</div>` : ""}
      <form method="POST" action="/admin/masuk">
        <h2 style="margin-top:14px">Nama Anda</h2>
        <input name="nama" required autocomplete="name" style="text-transform:none;letter-spacing:0">
        <h2 style="margin-top:14px">Kata sandi admin</h2>
        <input name="sandi" type="password" required style="letter-spacing:0">
        <button type="submit">Masuk</button>
      </form>
    </div></div>`,
  );
}

function row(t: tickets.Found, c: Ctx, query: string): string {
  const state = t.checked_at
    ? `<span class="tag ok">Hadir ${c.esc(c.wib(t.checked_at))}</span>`
    : `<span class="tag">Belum hadir</span>`;
  const revoked =
    t.status === "revoked" ? `<span class="tag bad">Dibatalkan</span>` : "";

  // Each action carries its own reason box. A single shared one would attach
  // whatever was last typed to whichever button was pressed.
  const act = (action: string, label: string, cls = "") => `
    <form method="POST" action="/admin/${action}" class="act">
      <input type="hidden" name="ticket_id" value="${c.esc(t.ticket_id)}">
      <input type="hidden" name="q" value="${c.esc(query)}">
      <input name="reason" placeholder="Alasan" required
             style="text-transform:none;letter-spacing:0;font-size:14px;text-align:left">
      <button class="${cls}" type="submit">${label}</button>
    </form>`;

  return `<div class="card">
    <div class="nm">${c.esc(t.name)}${t.is_staff ? ' <span class="tag">panitia</span>' : ""}</div>
    <div class="meta">${c.esc(t.manual_code)} · ${c.esc(t.wa_number)}</div>
    <div class="tags">${state} ${revoked}</div>
    ${t.status === "active" ? act("revoke", "Batalkan tiket", "danger") : act("restore", "Aktifkan lagi")}
    ${t.checked_at ? act("undo", "Batalkan check-in", "danger") : act("admit", "Tandai hadir")}
  </div>`;
}

/**
 * Banner shown while the lab is open to everyone.
 *
 * Stays at the top of the page. The danger with an override is not flipping it
 * during an emergency — it is nobody remembering it is still on afterwards, so
 * the live state is the first thing on the screen, with its own way back.
 */
function labOpenBanner(c: Ctx): string {
  return `<div class="card" style="border:2px solid #a06a00;background:#fdf4e0">
        <div class="nm" style="color:#6d4800">Lab terbuka untuk semua</div>
        <p class="meta">Peserta bisa memakai AIMPACT tanpa check-in.
        Kembalikan ke normal setelah scanner berfungsi lagi.</p>
        <form method="POST" action="/admin/lab" class="act">
          <input type="hidden" name="open" value="0">
          <input name="reason" placeholder="Alasan menutup" required
                 style="text-transform:none;letter-spacing:0;font-size:14px;text-align:left">
          <button type="submit">Wajibkan check-in lagi</button>
        </form>
      </div>`;
}

/**
 * The control that opens the lab, kept at the very bottom of the page.
 *
 * It is a break-glass lever used when the scanner fails, not something anyone
 * needs while searching for a participant — so it does not sit above the
 * search box being used every thirty seconds.
 */
/**
 * Opens or closes the post-test.
 *
 * Loud while open, like the lab override, for the same reason: the risk is not
 * flipping it when the session ends, it is nobody noticing it stayed open
 * afterwards — or, worse, that it was open all along and people sat it before
 * the material.
 */
function postTestControl(c: Ctx, open: boolean): string {
  return open
    ? `<div class="card" style="border:2px solid #1a7f4b;background:#eef8f2">
        <div class="nm" style="color:#0d5c34">Post-test dibuka</div>
        <p class="meta">Peserta dapat mengisi post-test di
        tiket.iaitbjambi.org/post. Tutup setelah sesi benar-benar selesai.</p>
        <form method="POST" action="/admin/post-test" class="act">
          <input type="hidden" name="open" value="0">
          <input name="reason" placeholder="Alasan menutup" required
                 style="text-transform:none;letter-spacing:0;font-size:14px;text-align:left">
          <button type="submit">Tutup post-test</button>
        </form>
      </div>`
    : `<div class="card">
        <h2>Post-test</h2>
        <p class="meta">Masih tertutup. Buka setelah sesi materi selesai, lalu
        umumkan alamat <b>tiket.iaitbjambi.org/post</b> kepada peserta.</p>
        <form method="POST" action="/admin/post-test" class="act">
          <input type="hidden" name="open" value="1">
          <input name="reason" placeholder="Alasan membuka" required
                 style="text-transform:none;letter-spacing:0;font-size:14px;text-align:left">
          <button type="submit">Buka post-test</button>
        </form>
      </div>`;
}

function labOpenControl(c: Ctx): string {
  return `<div class="card">
        <h2>Akses lab</h2>
        <p class="meta">Saat ini peserta harus check-in dulu sebelum bisa
        memakai AIMPACT. Buka untuk semua hanya jika scanner bermasalah.</p>
        <form method="POST" action="/admin/lab" class="act">
          <input type="hidden" name="open" value="1">
          <input name="reason" placeholder="Alasan membuka" required
                 style="text-transform:none;letter-spacing:0;font-size:14px;text-align:left">
          <button class="danger" type="submit">Buka lab untuk semua</button>
        </form>
      </div>`;
}

export function dashboard(
  c: Ctx,
  who: string,
  counts: tickets.Counts,
  query: string,
  results: tickets.Found[],
  notice = "",
  labIsOpen = false,
  postIsOpen = false,
): Response {
  const list = query
    ? results.length
      ? results.map((t) => row(t, c, query)).join("")
      : `<div class="card"><p class="meta">Tidak ada yang cocok dengan
         "${c.esc(query)}".</p></div>`
    : "";

  return c.page(
    "Admin",
    `<div class="wrap">
      <div class="card">
        <h2>Admin: ${c.esc(who)}</h2>
        <div class="row">
          <div><div class="big">${counts.attended}</div><div class="meta">Hadir</div></div>
          <div><div class="big">${counts.invited - counts.attended}</div><div class="meta">Belum</div></div>
          <div><div class="big">${counts.invited}</div><div class="meta">Diundang</div></div>
        </div>
      </div>
      ${notice}
      ${labIsOpen ? labOpenBanner(c) : ""}
      ${postIsOpen ? postTestControl(c, true) : ""}
      <div class="card">
        <h2>Cari peserta</h2>
        <form method="GET" action="/admin">
          <input name="q" value="${c.esc(query)}" placeholder="Nama atau kode"
                 style="text-transform:none;letter-spacing:0">
          <button type="submit">Cari</button>
        </form>
      </div>
      ${list}
      <a class="btn ghost" href="/admin/kirim">Kirim pesan WhatsApp ke peserta</a>
      <a class="btn ghost" href="/admin/peserta">Daftar peserta &amp; website</a>
      <a class="btn ghost" href="/admin/hadir.csv">Unduh daftar hadir (CSV)</a>
      <a class="btn ghost" href="/admin/log">Riwayat tindakan admin</a>
      <a class="btn ghost" href="/scan">Buka scanner</a>
      <form method="POST" action="/admin/keluar"><button class="ghost" type="submit">Keluar</button></form>
      ${postIsOpen ? "" : postTestControl(c, false)}
      ${labIsOpen ? "" : labOpenControl(c)}
    </div>`,
  );
}

/**
 * The whole list: who is coming, their code, and where their site will live.
 *
 * Joins the ticket (Supabase) to the lab account (D1), because the site label
 * is assigned at issuance and only D1 holds it. Filters rather than paginates
 * — 205 rows is one screen of scrolling on a phone, and a help desk wants to
 * search by eye, not click through pages.
 */
export function listPage(
  c: Ctx,
  rows: tickets.Found[],
  sites: Map<string, { slug: string | null; built: boolean }>,
  panitia: Set<string>,
  tokens: Map<string, string>,
  pre: Map<string, assessment.Result>,
  post: Map<string, assessment.Result>,
  filter: string,
  domain: string,
  /**
   * Where the filter tabs point, so the same table serves /admin/peserta and
   * /papan without either hard-coding the other's path.
   */
  base = "/admin/peserta",
  /**
   * Whether to render the code and the ticket link.
   *
   * False on the attendance board: that page is left face-up on a desk and
   * turned towards a queue, and those two columns are working credentials for
   * the door and the lab. Everything else on the row is safe to show.
   */
  secrets = true,
  /** Rendered above the tabs; /papan puts its counters here. */
  headerHtml = "",
): Response {
  // Cancelled tickets are not part of the roster: showing them as "belum
  // hadir" would send a volunteer looking for somebody who is not coming.
  // They remain findable, and restorable, through the /admin search.
  rows = rows.filter((t) => t.status === "active");
  const want = (t: tickets.Found) =>
    filter === "hadir" ? Boolean(t.checked_at)
    : filter === "belum" ? !t.checked_at
    : filter === "jadi" ? sites.get(t.manual_code)?.built
    : filter === "panitia" ? panitia.has(t.manual_code)
    : filter === "belumtest" ? !pre.has(t.manual_code)
    : filter === "belumpost" ? !post.has(t.manual_code)
    : true;

  const shown = rows.filter(want);
  const tab = (key: string, label: string) =>
    `<a class="tab${filter === key ? " on" : ""}" href="${base}?f=${key}">${label}</a>`;

  // Numbered within the current filter, so "row 83" means the 83rd of what is
  // on screen rather than a position in a list nobody is looking at.
  // Numbered within the current filter, so "row 83" means the 83rd of what is
  // on screen rather than a position in a list nobody is looking at.
  //
  // Six columns, and every cell wraps. An earlier version scrolled sideways
  // inside its own box, which reads badly on a phone held one-handed at a
  // registration desk — the two status columns are merged instead.
  const body = shown
    .map((t, i) => {
      const site = sites.get(t.manual_code);
      const host = site?.slug ? `${site.slug}.${domain}` : null;
      const tok = tokens.get(t.manual_code);
      return `<tr>
        <td class="num">${i + 1}</td>
        <td class="pname">${c.esc(t.name)}<div class="ket">${
          panitia.has(t.manual_code) ? "Panitia" : "Peserta"
        }</div></td>
        ${
          secrets
            ? `<td class="code">${c.esc(t.manual_code)}</td>
        <td class="link">${
          tok
            ? `<a href="https://tiket.${domain}/t/${c.esc(tok)}" target="_blank" rel="noopener">tiket.${domain}/t/${c.esc(tok)}</a>`
            : `<span class="meta">-</span>`
        }</td>`
            : ""
        }
        <td class="link">${
          host
            ? `<a href="https://${c.esc(host)}" target="_blank" rel="noopener">${c.esc(host)}</a>`
            : `<span class="meta">-</span>`
        }</td>
        <td class="st">${
          t.checked_at
            ? `<span class="tag ok">hadir ${c.esc(c.wib(t.checked_at))}</span>`
            : `<span class="tag">belum hadir</span>`
        }${
          site?.built ? `<span class="tag ok">web jadi</span>` : ""
        }</td>
        <td class="st">${
          pre.has(t.manual_code)
            ? `<span class="tag ok">${pre.get(t.manual_code)!.score}</span>`
            : `<span class="tag bad">belum melakukan test</span>`
        }</td>
        <td class="st">${(() => {
          const a = pre.get(t.manual_code);
          const b = post.get(t.manual_code);
          if (!b) return `<span class="tag bad">belum melakukan test</span>`;
          const d = a ? b.score - a.score : null;
          const move =
            d === null ? "" : d > 0 ? ` <span class="tag ok">+${d}</span>`
            : d < 0 ? ` <span class="tag bad">${d}</span>`
            : ` <span class="tag">0</span>`;
          return `<span class="tag ok">${b.score}</span>${move}`;
        })()}</td>
      </tr>`;
    })
    .join("");

  return c.page(
    "Daftar peserta",
    `<div class="wrap wide">
      ${headerHtml}
      <div class="card">
        <h2>Daftar peserta</h2>
        <div class="tabs">
          ${tab("semua", `Semua (${rows.length})`)}
          ${tab("hadir", `Hadir (${rows.filter((t) => t.checked_at).length})`)}
          ${tab("belum", `Belum (${rows.filter((t) => !t.checked_at).length})`)}
          ${tab("jadi", `Website jadi (${rows.filter((t) => sites.get(t.manual_code)?.built).length})`)}
          ${tab("panitia", `Panitia (${rows.filter((t) => panitia.has(t.manual_code)).length})`)}
          ${tab("belumtest", `Belum pre-test (${rows.filter((t) => !pre.has(t.manual_code)).length})`)}
          ${tab("belumpost", `Belum post-test (${rows.filter((t) => !post.has(t.manual_code)).length})`)}
        </div>
      </div>
      <div class="card plist">
        ${
          shown.length
            ? `<table>
                 <thead><tr><th class="num">#</th><th>Nama</th>
                 ${secrets ? "<th>Kode</th><th>Link tiket</th>" : ""}
                 <th>Website</th><th>Status</th>
                 <th>Pre-test</th><th>Post-test</th></tr></thead>
                 <tbody>${body}</tbody>
               </table>`
            : '<p class="meta" style="padding:14px 16px">Tidak ada.</p>'
        }
      </div>
      ${
        secrets
          ? `<a class="btn ghost" href="/admin/hadir.csv">Unduh daftar hadir (CSV)</a>
             <a class="btn ghost" href="/admin">Kembali</a>`
          : `<a class="btn ghost" href="/scan">Kembali ke scanner</a>`
      }
    </div>`,
  );
}

/**
 * The message every participant receives. One place, so the text sent on the
 * day is the text that was approved rather than a retyped approximation.
 *
 * Plain ASCII only, and no asterisks.
 *
 * Asterisks are WhatsApp's bold markers: a stray one pairs with another and
 * eats both, along with whatever sits between them.
 *
 * The date, time and place lines used emoji until the organiser reported them
 * arriving as replacement characters. The link itself is correct - the server
 * percent-encodes them properly as UTF-8 - but something between the browser
 * and the chat decodes the text parameter as single-byte, so each emoji became
 * three of them. A label that renders on every device beats an icon that
 * renders on some.
 */
export function pesanPeserta(nama: string, tiket: string, kode: string, site: string): string {
  return `Halo ${nama},

Selamat! Anda terdaftar sebagai peserta AIMPACT - AI untuk UMKM yang dilaksanakan pada:
Tanggal : Kamis, 17 September 2026
Waktu : 08.00 - Selesai
Lokasi : Aula Griya Mayang, Rumah Dinas Walikota Jambi
https://maps.app.goo.gl/GBCFe1FW6XhZSmNW9

TIKET ANDA
${tiket}

Buka link di atas, lalu isi Pre-test dan anda akan mendapatkan ticket anda. SIMPAN gambar QR ke galeri HP Anda. Tunjukkan QR tersebut di meja registrasi. Dengan menyimpannya, Anda tidak perlu sinyal saat mengantre.

KODE ANDA: ${kode}

Sebutkan kode ini jika kamera petugas bermasalah.

SETELAH REGISTRASI
Anda akan membuat website usaha Anda sendiri dengan bantuan AI, di:
https://aimpact.iaitbjambi.org

Masukkan kode yang sama, lalu ceritakan usaha Anda. Website Anda akan hidup di:
${site}

Mohon diperhatikan: website baru bisa dibuat SETELAH Anda registrasi di meja panitia.

Setelah sesi selesai lakukan pengisian post test. Sebelum anda meninggalkan seminar.

Tiket ini hanya untuk Anda dan tidak dapat dipindahtangankan.
Sampai jumpa di AImpact!`;
}

/**
 * Sending page: one WhatsApp button per participant, with the message already
 * written.
 *
 * WhatsApp cannot be sent from a server without the paid Business API, so the
 * admin still presses send. What this removes is the part that actually goes
 * wrong by hand: pasting the wrong person's ticket link into the wrong chat.
 *
 * Progress is stored server-side rather than in the browser, because sending
 * 186 messages is a job two people split and each needs to see the other's
 * work.
 */
export function sendPage(
  c: Ctx,
  rows: tickets.Found[],
  sites: Map<string, { slug: string | null; built: boolean }>,
  tokens: Map<string, string>,
  sent: Set<string>,
  filter: string,
  domain: string,
  base = "/admin/kirim",
): Response {
  // A revoked ticket is dead: sending it would hand somebody a link that no
  // longer works. Replaced participants drop off this list; their successors
  // appear in their place.
  rows = rows.filter((t) => t.status === "active");
  const withPhone = rows.filter((t) => t.wa_number && t.wa_number !== "-");
  const done = rows.filter((t) => sent.has(t.manual_code)).length;

  const shown = rows.filter((t) =>
    filter === "belum" ? !sent.has(t.manual_code)
    : filter === "sudah" ? sent.has(t.manual_code)
    : filter === "tanpa" ? !t.wa_number || t.wa_number === "-"
    : true,
  );

  const tab = (key: string, label: string) =>
    `<a class="tab${filter === key ? " on" : ""}" href="${base}?f=${key}">${label}</a>`;

  const cards = shown
    .map((t, i) => {
      const tok = tokens.get(t.manual_code);
      const slug = sites.get(t.manual_code)?.slug;
      const site = slug ? `https://${slug}.${domain}` : "";
      const msg = pesanPeserta(
        t.name,
        tok ? `https://tiket.${domain}/t/${tok}` : "(link tiket tidak tersedia)",
        t.manual_code,
        site || "(alamat belum tersedia)",
      );
      const phone = t.wa_number && t.wa_number !== "-" ? t.wa_number : null;
      const href = phone
        ? `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`
        : `https://wa.me/?text=${encodeURIComponent(msg)}`;
      const isSent = sent.has(t.manual_code);

      return `<div class="sr${isSent ? " done" : ""}">
        <div class="who"><span class="idx">${i + 1}.</span><b>${c.esc(t.name)}</b>
          ${isSent ? '<span class="tag ok">terkirim</span>' : ""}
          ${phone ? "" : '<span class="tag bad">tanpa nomor</span>'}</div>
        <div class="meta">${c.esc(phone ?? "pilih kontak saat mengirim")}</div>
        <div class="acts">
          <a class="wa" href="${c.esc(href)}" target="_blank" rel="noopener"
             data-code="${c.esc(t.manual_code)}">Kirim WhatsApp</a>
          <form method="POST" action="${base}">
            <input type="hidden" name="code" value="${c.esc(t.manual_code)}">
            <input type="hidden" name="sent" value="${isSent ? "0" : "1"}">
            <input type="hidden" name="f" value="${c.esc(filter)}">
            <button class="tick${isSent ? " on" : ""}" type="submit"
              title="${isSent ? "Batalkan tanda terkirim" : "Tandai sudah terkirim"}">
              <span class="box">${isSent ? "&#10003;" : ""}</span>${
                isSent ? "Sudah dikirim" : "Tandai terkirim"
              }</button>
          </form>
        </div>
      </div>`;
    })
    .join("");

  return c.page(
    "Kirim pesan peserta",
    `<div class="wrap wide">
      <div class="card">
        <h2>Kirim pesan ke peserta</h2>
        <p class="meta">${done} dari ${rows.length} sudah ditandai terkirim.
        ${rows.length - withPhone.length} peserta tanpa nomor WhatsApp.</p>
        <div class="bar"><span style="width:${
          rows.length ? Math.round((done / rows.length) * 100) : 0
        }%"></span></div>
        <div class="tabs" style="margin-top:10px">
          ${tab("semua", `Semua (${rows.length})`)}
          ${tab("belum", `Belum (${rows.length - done})`)}
          ${tab("sudah", `Terkirim (${done})`)}
          ${tab("tanpa", `Tanpa nomor (${rows.length - withPhone.length})`)}
        </div>
        <p class="hint">Tekan tombol hijau: WhatsApp terbuka dengan pesan sudah terisi,
        Anda tinggal menekan kirim. Setelah kembali ke halaman ini, tandai terkirim.</p>
      </div>
      <div class="card plist">${cards || '<p class="meta" style="padding:14px 16px">Tidak ada.</p>'}</div>
      <a class="btn ghost" href="${base === "/kirim" ? "/scan" : "/admin"}">Kembali</a>
    </div>`,
  );
}

export function auditPage(c: Ctx, entries: tickets.AuditEntry[]): Response {
  const rows = entries.length
    ? entries
        .map(
          (e) => `<div class="card">
            <div class="meta">${c.esc(c.wib(e.at))} · ${c.esc(e.actor)}</div>
            <div class="nm" style="font-size:16px">${c.esc(e.action)}${
              e.detail ? ` — ${c.esc(e.detail)}` : ""
            }</div>
            <div class="meta">Alasan: ${c.esc(e.reason)}</div>
          </div>`,
        )
        .join("")
    : `<div class="card"><p class="meta">Belum ada tindakan admin.</p></div>`;

  return c.page(
    "Riwayat admin",
    `<div class="wrap"><h1 style="padding:0 4px">Riwayat tindakan</h1>${rows}
      <a class="btn ghost" href="/admin">Kembali</a>
      <form method="POST" action="/admin/keluar"><button class="ghost" type="submit">Keluar</button></form>
    </div>`,
  );
}

/**
 * Handles the admin routes. Returns null when the path is not an admin one,
 * so the caller can carry on with its own routing.
 */
export async function handle(
  req: Request,
  env: Env,
  c: Ctx,
  who: string | null,
  signIn: (message?: string) => Response,
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith("/admin")) return null;

  if (path === "/admin/masuk" && req.method === "POST") {
    const form = await req.formData();
    const name = String(form.get("nama") ?? "").replace(/[:|]/g, " ").trim().slice(0, 40);
    const pass = String(form.get("sandi") ?? "");
    if (!env.ADMIN_PASSWORD || pass !== env.ADMIN_PASSWORD || !name) {
      return signIn("Nama atau kata sandi salah.");
    }
    return new Response(null, {
      status: 303,
      headers: { location: "/admin", "set-cookie": await c.cookie(env, name) },
    });
  }

  if (!who) return signIn();

  if (path === "/admin/hadir.csv") {
    return new Response(attendanceCsv(await tickets.all(env), c.wib), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="daftar-hadir.csv"`,
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }

  if (path === "/admin/log") return auditPage(c, await tickets.audit(env));

  if (path === "/admin/kirim") {
    if (req.method === "POST") {
      const form = await req.formData();
      await tickets.markSent(env, String(form.get("code") ?? ""), form.get("sent") === "1");
      const back = String(form.get("f") ?? "semua");
      return new Response(null, {
        status: 303,
        headers: { location: `/admin/kirim?f=${encodeURIComponent(back)}` },
      });
    }
    const [rows, sites, tokens, sent] = await Promise.all([
      tickets.all(env),
      new Store(env.DB).siteIndex(),
      tickets.ticketTokens(env),
      tickets.sentCodes(env),
    ]);
    return sendPage(c, rows, sites, tokens, sent,
      url.searchParams.get("f") ?? "belum", env.DOMAIN);
  }

  if (path === "/admin/peserta") {
    const [rows, sites, panitia, tokens, pre, post] = await Promise.all([
      tickets.all(env, true),
      new Store(env.DB).siteIndex(),
      tickets.panitiaCodes(env),
      tickets.ticketTokens(env),
      assessment.all(env, "pre"),
      assessment.all(env, "post"),
    ]);
    return listPage(c, rows, sites, panitia, tokens, pre, post,
      url.searchParams.get("f") ?? "semua", env.DOMAIN);
  }

  if (req.method === "POST") {
    const form = await req.formData();
    const id = String(form.get("ticket_id") ?? "");
    const reason = String(form.get("reason") ?? "").trim().slice(0, 200);
    let notice = "";
    try {
      if (path === "/admin/revoke") {
        await tickets.setStatus(env, id, "revoked", who, reason);
        notice = "Tiket dibatalkan.";
      } else if (path === "/admin/restore") {
        await tickets.setStatus(env, id, "active", who, reason);
        notice = "Tiket diaktifkan lagi.";
      } else if (path === "/admin/undo") {
        await tickets.undoCheckIn(env, id, who, reason);
        notice = "Check-in dibatalkan.";
      } else if (path === "/admin/post-test") {
        const open = String(form.get("open") ?? "") === "1";
        await assessment.setPostOpen(env, open, who, reason);
        notice = open ? "Post-test dibuka." : "Post-test ditutup.";
      } else if (path === "/admin/lab") {
        const open = String(form.get("open") ?? "") === "1";
        await tickets.setLabOpen(env, open, who, reason);
        notice = open
          ? "Lab dibuka untuk semua peserta."
          : "Lab kembali membutuhkan check-in.";
      } else if (path === "/admin/admit") {
        await tickets.adminAdmit(env, id, who, reason);
        notice = "Ditandai hadir.";
      } else {
        return new Response(null, { status: 303, headers: { location: "/admin" } });
      }
    } catch (err) {
      const raw = String(err);
      console.error("admin", path, id, raw);
      notice = raw.includes("reason required")
        ? "Gagal: alasan wajib diisi."
        : raw.includes("ticket not found") || raw.includes("no_data_found")
          ? "Gagal: tiket tidak ditemukan."
          : raw.includes("ticket not active")
            ? "Gagal: tiket dibatalkan, aktifkan dulu."
            : "Gagal: sistem sedang bermasalah. Coba lagi.";
    }
    // Redirect back to the search that was open, so the list does not vanish
    // under whoever just acted on it.
    const back = String(form.get("q") ?? "");
    return new Response(null, {
      status: 303,
      headers: {
        location: `/admin?q=${encodeURIComponent(back)}&m=${encodeURIComponent(notice)}`,
      },
    });
  }

  const query = url.searchParams.get("q") ?? "";
  const message = url.searchParams.get("m") ?? "";
  const notice = message
    ? `<div class="res ${message.startsWith("Gagal") ? "bad" : "ok"}"><b>${c.esc(
        message,
      )}</b></div>`
    : "";
  const [counts, labIsOpen, postIsOpen, results] = await Promise.all([
    tickets.counts(env),
    tickets.labOpen(env),
    assessment.postOpen(env),
    query ? tickets.search(env, query) : Promise.resolve([]),
  ]);
  return dashboard(c, who, counts, query, results, notice, labIsOpen, postIsOpen);
}

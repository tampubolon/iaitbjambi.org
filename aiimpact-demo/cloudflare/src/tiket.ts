/**
 * Registration site — tiket.<domain>.
 *
 *   /t/{token}          the participant's ticket: name, QR, manual code
 *   /qr/{token}.png     the same QR as a raster, for the Sheets template
 *   /masuk              staff sign-in
 *   /scan               camera scanner + manual code entry
 *   /api/check          look a ticket up without admitting anyone
 *   /api/checkin        record attendance, atomically
 *   /papan              live counts
 *
 * Server-rendered rather than the React app the PRD assumes (s8). With three
 * days to the event, a build pipeline and a second deployment target are
 * machinery with no payoff: every page here is one screen of markup, and the
 * only real client-side work is reading frames from a camera.
 *
 * Nothing on a ticket or scanner page may be cached or indexed — the URL is
 * the credential.
 */
import type { Env, Ticket } from "./model";
import { png, svg } from "./qr";
import { sign, verify } from "./auth";
import * as admin from "./admin";
import * as tickets from "./ticket";

const PRIVATE = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

/**
 * Formats a Postgres timestamptz as Jakarta wall-clock time.
 *
 * Postgres returns UTC ISO ("2026-09-14T16:56:22.79+00:00"); the door needs
 * "23:56". Labelling the raw UTC string "WIB" would be wrong by seven hours,
 * which is exactly the kind of thing nobody notices until someone disputes
 * when they arrived.
 */
export function wib(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}

/** Escapes text for HTML. Participant names are data, not markup. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function page(title: string, body: string, extraHead = ""): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${CSS}</style>${extraHead}</head><body>${body}</body></html>`,
    { headers: PRIVATE },
  );
}

const CSS = `
:root{--ink:#14202e;--muted:#5b6b7f;--line:#dde4ec;--bg:#f5f7fa;--card:#fff;
--ok:#1a7f4b;--warn:#a06a00;--bad:#b3261e;--brand:#12507e}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:460px;margin:0 auto;padding:20px 16px 40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:14px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px;color:var(--muted);font-weight:600}
.name{font-size:26px;font-weight:700;line-height:1.2;margin:2px 0 14px}
.qr{background:#fff;padding:12px;border-radius:10px;display:block;margin:0 auto;width:min(300px,78vw)}
.qr svg{display:block;width:100%;height:auto}
.code.bld{color:var(--brand)}
.code{font:700 26px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;
text-align:center;padding:12px;background:var(--bg);border-radius:10px;margin-top:6px}
.meta{color:var(--muted);font-size:14px;margin:2px 0}
.hint{color:var(--muted);font-size:13px;margin-top:14px}
a.btn,button{display:block;width:100%;padding:14px;border-radius:10px;border:0;
background:var(--brand);color:#fff;font:600 16px system-ui;text-align:center;
text-decoration:none;margin-top:10px;cursor:pointer}
button.ghost{background:#fff;color:var(--brand);border:1.5px solid var(--brand)}
select{width:100%;padding:13px;border:1.5px solid var(--line);border-radius:10px;
font:600 16px system-ui;background:#fff;color:var(--ink)}
input{width:100%;padding:13px;border:1.5px solid var(--line);border-radius:10px;
font:600 20px ui-monospace,monospace;text-align:center;letter-spacing:.1em;text-transform:uppercase}
video{width:100%;border-radius:12px;background:#000;display:block}
.res{padding:16px;border-radius:12px;margin-bottom:12px;border-left:6px solid}
.res b{display:block;font-size:22px;margin-bottom:2px}
.ok{background:#e8f6ee;border-color:var(--ok);color:#0d5c34}
.warn{background:#fdf4e0;border-color:var(--warn);color:#6d4800}
.bad{background:#fdeceb;border-color:var(--bad);color:#8c1d18}
.grey{background:#eef1f5;border-color:#94a3b5;color:#3c4a5c}
.big{font-size:40px;font-weight:700;line-height:1}
.nm{font-size:18px;font-weight:700;line-height:1.2}
.tags{margin:6px 0 10px}
.tag{display:inline-block;font-size:12px;font-weight:600;padding:3px 9px;border-radius:99px;
background:#eef1f5;color:#3c4a5c;margin-right:5px}
.tag.ok{background:#e8f6ee;color:#0d5c34}
.tag.bad{background:#fdeceb;color:#8c1d18}
.tag.brand{background:#e7f0f8;color:var(--brand)}
.act{display:flex;gap:7px;margin-top:7px}
.act input{flex:1;font-size:14px;padding:9px}
.act button{width:auto;flex:none;margin-top:0;padding:9px 13px;font-size:14px;white-space:nowrap}
.act button.danger{background:#b3261e}
.wrap.wide{max-width:760px}
.tabs{display:flex;flex-wrap:wrap;gap:6px}
.tab{font-size:13px;font-weight:600;padding:7px 11px;border-radius:99px;
background:#eef1f5;color:#3c4a5c;text-decoration:none}
.tab.on{background:var(--brand);color:#fff}
.plist{padding:0}
/* No sideways scrolling: every cell wraps and the table fits whatever width
   the phone has. Long URLs break mid-string rather than forcing the page
   wider than the screen. */
table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:12.5px}
th,td{padding:8px 7px;text-align:left;border-bottom:1px solid var(--line);
vertical-align:top;overflow-wrap:anywhere;word-break:break-word}
th{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
tbody tr:last-child td{border-bottom:0}
tbody tr:nth-child(even){background:#fafbfc}
td.num,th.num{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;width:8%}
td.pname{font-weight:700}
.ket{font-weight:600;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;
color:var(--muted);margin-top:2px}
td.code{font:700 12.5px ui-monospace,monospace;letter-spacing:.06em;color:var(--brand);width:14%}
td.link a{color:var(--muted);font-size:11px;line-height:1.35}
td.st .tag{display:inline-block;margin:0 3px 3px 0;font-size:11px;padding:2px 7px}
.row{display:flex;gap:10px}.row>div{flex:1;text-align:center;
background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 8px}
`;

function eventLine(env: Env): string {
  const name = env.EVENT_NAME || "AIMPACT — AI untuk UMKM";
  const date = env.EVENT_DATE || "17 September 2026";
  const place = env.EVENT_PLACE || "Kota Jambi";
  return `<p class="meta"><strong>${esc(name)}</strong></p>
          <p class="meta">${esc(date)} · ${esc(place)}</p>`;
}

// --- participant ------------------------------------------------------

function ticketPage(t: Ticket, token: string, env: Env): Response {
  const url = `https://tiket.${env.DOMAIN}/t/${token}`;
  const already = t.checked_at
    ? `<div class="res ok"><b>Sudah check-in</b>${esc(wib(t.checked_at))} WIB</div>`
    : "";


  return page(
    `Tiket — ${t.name}`,
    `<div class="wrap">
      ${already}
      <div class="card">
        <h2>Tiket peserta</h2>
        <div class="name">${esc(t.name)}</div>
        ${eventLine(env)}
        <div class="qr">${svg(url, 300)}</div>
        <p class="hint" style="text-align:center">Tunjukkan QR ini di meja registrasi.</p>
        <h2 style="margin-top:18px">Kode Anda</h2>
        <div class="code">${esc(t.manual_code)}</div>
        <p class="hint">Satu kode untuk dua hal: sebutkan di meja registrasi
        jika kamera bermasalah, dan masukkan di AIMPACT untuk membuat website
        usaha Anda.</p>
        <a class="btn" href="/qr/${esc(token)}.png" download="tiket-qr.png">Simpan gambar QR</a>
        <p class="hint">Simpan sekarang supaya tidak perlu sinyal saat antre.
        Tiket ini hanya untuk Anda dan tidak dapat dipindahtangankan.</p>
      </div>
      <div class="card">
        <h2>Setelah registrasi</h2>
        <p class="meta">Buat website usaha Anda dengan AI, pakai kode yang sama.</p>
        <a class="btn" href="https://aimpact.${env.DOMAIN}/">Buka AIMPACT</a>
      </div>
    </div>`,
  );
}

// --- staff ------------------------------------------------------------

const STAFF_COOKIE = "petugas";

/**
 * Reads a signed session cookie and returns the holder's name.
 *
 * The role is part of the signed payload, not just the cookie name. Both
 * cookies are signed with the same secret, so without binding the role a
 * volunteer could rename their `petugas` cookie to `admin` and be an admin —
 * the signature would still verify.
 */
async function sessionName(
  req: Request,
  env: Env,
  role: "petugas" | "admin",
): Promise<string | null> {
  const raw = req.headers.get("cookie") ?? "";
  const hit = new RegExp(`(?:^|;\\s*)${role}=([^;]+)`).exec(raw);
  if (!hit || !env.SESSION_SECRET) return null;
  try {
    // verify() throws on a bad or expired signature; at the door that is just
    // "sign in again", not a 500.
    const subject = await verify(env.SESSION_SECRET, decodeURIComponent(hit[1]!));
    const sep = subject.indexOf("|");
    if (sep < 1 || subject.slice(0, sep) !== role) return null;
    return subject.slice(sep + 1);
  } catch {
    return null;
  }
}

const staffName = (req: Request, env: Env) => sessionName(req, env, "petugas");
const adminName = (req: Request, env: Env) => sessionName(req, env, "admin");

/**
 * Expires a session cookie. Same Path and flags, or the browser treats it as a
 * different cookie and leaves the original in place.
 *
 * This clears the browser's copy; it does not invalidate the signed token,
 * which stays valid until its sixteen hours are up. That covers what sign-out
 * is actually for here — handing a phone to someone, or walking away from a
 * borrowed laptop — but not a token that was captured beforehand. Revoking
 * those would need server-side session state, which this does not have.
 */
function clearCookie(role: string): string {
  return `${role}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Issues a session cookie whose payload names the role it grants. */
async function sessionCookie(env: Env, role: string, name: string): Promise<string> {
  const token = await sign(env.SESSION_SECRET, `${role}|${name}`);
  return (
    `${role}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; ` +
    `SameSite=Lax; Max-Age=57600`
  );
}

function signIn(names: string[] = [], message = ""): Response {
  const options = names
    .map((n) => `<option value="${esc(n)}">${esc(n)}</option>`)
    .join("");

  return page(
    "Masuk petugas",
    `<div class="wrap"><div class="card">
      <h1>Masuk petugas</h1>
      ${message ? `<div class="res bad"><b>Gagal</b>${esc(message)}</div>` : ""}
      <form method="POST" action="/masuk">
        <h2 style="margin-top:14px">Nama Anda</h2>
        ${
          options
            ? `<select name="nama" required>
                 <option value="" disabled selected>Pilih nama</option>${options}
               </select>`
            : `<p class="meta">Daftar petugas belum diatur. Hubungi admin.</p>`
        }
        <h2 style="margin-top:14px">Kata sandi petugas</h2>
        <input name="sandi" type="password" required style="letter-spacing:0">
        <button type="submit">Masuk</button>
      </form>
    </div></div>`,
  );
}

function scanPage(who: string): Response {
  return page(
    "Scanner",
    `<div class="wrap">
      <div class="card">
        <h2>Petugas: ${esc(who)}</h2>
        <div id="out"></div>
        <video id="v" playsinline muted></video>
        <button class="ghost" id="flip" type="button">Ganti kamera</button>
      </div>
      <div class="card">
        <h2>Atau masukkan kode cadangan</h2>
        <input id="manual" maxlength="12" placeholder="KODE" autocomplete="off">
        <button id="find" type="button">Cari</button>
      </div>
      <a class="btn ghost" href="/papan">Lihat jumlah hadir</a>
      <form method="POST" action="/keluar"><button class="ghost" type="submit">Keluar</button></form>
    </div>
    <script src="/vendor/jsQR.js"></script>
    <script>${SCANNER_JS}</script>`,
  );
}

/**
 * Scanner client.
 *
 * Uses the platform BarcodeDetector where it exists (Android Chrome) and jsQR
 * on a canvas otherwise, because iOS Safari has no BarcodeDetector and the PRD
 * requires both (s12).
 *
 * `busy` is the important part: the camera keeps producing frames while a
 * check-in is in flight, and without the guard one participant's ticket is
 * submitted a dozen times before the first response lands.
 */
const SCANNER_JS = String.raw`
(function () {
  var out = document.getElementById('out'), video = document.getElementById('v');
  var canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  var busy = false, last = '', lastAt = 0, stream = null, facing = 'environment', detector = null;

  function show(cls, title, detail) {
    out.innerHTML = '<div class="res ' + cls + '"><b>' + title + '</b>' + (detail || '') + '</div>';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  async function start() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
    } catch (err) {
      show('bad', 'Kamera tidak bisa dibuka', 'Gunakan kode cadangan di bawah.');
      return;
    }
    video.srcObject = stream; await video.play();
    if (!detector && 'BarcodeDetector' in window) {
      try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; }
    }
    requestAnimationFrame(tick);
  }

  async function tick() {
    if (!busy && video.readyState === 4) {
      var text = null;
      if (detector) {
        try { var found = await detector.detect(video); if (found.length) text = found[0].rawValue; } catch (e) {}
      } else if (window.jsQR) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        var code = window.jsQR(img.data, img.width, img.height);
        if (code) text = code.data;
      }
      // Same code twice within two seconds is the camera still pointing at it,
      // not a second person.
      if (text && (text !== last || Date.now() - lastAt > 2000)) {
        last = text; lastAt = Date.now();
        var m = /\/t\/([0-9A-HJKMNP-TV-Z]{26})/.exec(text);
        if (m) submit({ token: m[1] }); else show('bad', 'QR tidak dikenali', 'Bukan tiket acara ini.');
      }
    }
    requestAnimationFrame(tick);
  }

  async function submit(body) {
    busy = true;
    show('grey', 'Memeriksa…', '');
    try {
      var r = await fetch('/api/checkin', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      var d = await r.json();
      if (!r.ok) show('bad', d.title || 'Ditolak', esc(d.detail || ''));
      else if (d.first) show('ok', 'Berhasil check-in', esc(d.name) + ' · ' + esc(d.at) + ' WIB');
      else show('warn', 'Sudah hadir', esc(d.name) + ' · ' + esc(d.at) + ' WIB oleh ' + esc(d.by));
    } catch (err) {
      // The server may or may not have saved. Never claim success.
      show('grey', 'Belum terkonfirmasi', 'Periksa koneksi lalu scan ulang.');
    }
    setTimeout(function () { busy = false; }, 900);
  }

  document.getElementById('find').onclick = function () {
    var v = document.getElementById('manual').value.trim();
    if (v) submit({ code: v });
  };
  document.getElementById('flip').onclick = function () {
    facing = facing === 'environment' ? 'user' : 'environment'; start();
  };
  start();
})();
`;

function boardPage(c: tickets.Counts): Response {
  return page(
    "Papan kehadiran",
    `<div class="wrap">
      <div class="row">
        <div><div class="big">${c.attended}</div><div class="meta">Hadir</div></div>
        <div><div class="big">${c.invited - c.attended}</div><div class="meta">Belum</div></div>
        <div><div class="big">${c.invited}</div><div class="meta">Diundang</div></div>
      </div>
      ${c.revoked ? `<p class="hint">${c.revoked} tiket dibatalkan.</p>` : ""}
      <a class="btn ghost" href="/scan">Kembali ke scanner</a>
    </div>`,
    `<meta http-equiv="refresh" content="15">`,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// --- router -----------------------------------------------------------

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Admin first: its own password, its own cookie, its own role inside the
  // signature. A volunteer's scanner session is not an admin session.
  if (path.startsWith("/admin")) {
    const ctx = {
      esc,
      wib,
      page,
      cookie: (e: Env, name: string) => sessionCookie(e, "admin", name),
    };
    if (path === "/admin/keluar" && req.method === "POST") {
      return new Response(null, {
        status: 303,
        headers: { location: "/admin", "set-cookie": clearCookie("admin") },
      });
    }
    const who = await adminName(req, env);
    const handled = await admin.handle(req, env, ctx, who, (m?: string) =>
      admin.signInPage(ctx, m ?? ""),
    );
    if (handled) return handled;
  }

  // Ticket, by token. GET only and side-effect free: opening a ticket link,
  // or WhatsApp fetching a preview of it, must never admit anyone.
  const t = /^\/t\/([0-9A-HJKMNP-TV-Z]{26})\/?$/.exec(path);
  if (t) {
    const token = t[1]!;
    const ticket = await tickets.byToken(env, token);
    if (!ticket || ticket.status !== "active") {
      return page("Tiket tidak berlaku", `<div class="wrap"><div class="card">
        <h1>Tiket tidak berlaku</h1>
        <p class="meta">Tiket ini dibatalkan atau tidak dikenali.
        Silakan hubungi panitia di meja bantuan.</p></div></div>`);
    }
    return ticketPage(ticket, token, env);
  }

  // QR as a raster, for the Google Sheets distribution template. Revocation is
  // checked before rendering, though a copy already cached by Google will
  // outlive that -- which is why the scanner checks status again at the door.
  const q = /^\/qr\/([0-9A-HJKMNP-TV-Z]{26})\.png$/.exec(path);
  if (q) {
    const token = q[1]!;
    const ticket = await tickets.byToken(env, token);
    if (!ticket || ticket.status !== "active") return new Response("gone", { status: 404 });
    return new Response(png(`https://tiket.${env.DOMAIN}/t/${token}`, 6), {
      headers: {
        "content-type": "image/png",
        // Sheets refetches this for 200 rows; let Google cache it briefly.
        "cache-control": "private, max-age=300",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }

  if (path === "/keluar" && req.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: { location: "/masuk", "set-cookie": clearCookie(STAFF_COOKIE) },
    });
  }

  if (path === "/masuk") {
    const roster = await tickets.staffNames(env);
    if (req.method === "POST") {
      const form = await req.formData();
      const typed = String(form.get("nama") ?? "").trim().slice(0, 40);
      const pass = String(form.get("sandi") ?? "");
      // Match the roster case-insensitively but store the roster's spelling,
      // so attendance records read consistently whatever was submitted.
      const name = roster.find((n) => n.toLowerCase() === typed.toLowerCase()) ?? "";
      if (!env.STAFF_PASSWORD || pass !== env.STAFF_PASSWORD || !name) {
        return signIn(roster, "Nama atau kata sandi salah.");
      }
      return new Response(null, {
        status: 303,
        headers: {
          location: "/scan",
          "set-cookie": await sessionCookie(env, STAFF_COOKIE, name),
        },
      });
    }
    return signIn(roster);
  }

  if (path === "/scan" || path === "/papan" || path.startsWith("/api/")) {
    const who = await staffName(req, env);
    if (!who) {
      if (path.startsWith("/api/")) return json({ title: "Sesi berakhir" }, 401);
      return signIn(await tickets.staffNames(env));
    }

    if (path === "/scan") return scanPage(who);
    if (path === "/papan") return boardPage(await tickets.counts(env));

    if (path === "/api/checkin" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { token?: string; code?: string };
      const ticket = body.token
        ? await tickets.byToken(env, body.token)
        : body.code
          ? await tickets.byManualCode(env, body.code)
          : null;

      if (!ticket) return json({ title: "Tiket tidak dikenali", detail: "Arahkan ke meja bantuan." }, 404);
      if (ticket.status !== "active") {
        return json({ title: "Tiket dibatalkan", detail: "Arahkan ke meja bantuan." }, 409);
      }

      const result = await tickets.checkIn(env, ticket.ticket_id, who);
      return json({
        ...result,
        at: wib(result.at),
        name: ticket.name,
        code: ticket.manual_code,
      });
    }
    return json({ title: "Tidak ditemukan" }, 404);
  }

  // Bare host: staff go to sign-in, participants arrive via their own link.
  return new Response(null, { status: 302, headers: { location: "/masuk" } });
}

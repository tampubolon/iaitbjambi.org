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

export function dashboard(
  c: Ctx,
  who: string,
  counts: tickets.Counts,
  query: string,
  results: tickets.Found[],
  notice = "",
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
      <div class="card">
        <h2>Cari peserta</h2>
        <form method="GET" action="/admin">
          <input name="q" value="${c.esc(query)}" placeholder="Nama atau kode"
                 style="text-transform:none;letter-spacing:0">
          <button type="submit">Cari</button>
        </form>
      </div>
      ${list}
      <a class="btn ghost" href="/admin/hadir.csv">Unduh daftar hadir (CSV)</a>
      <a class="btn ghost" href="/admin/log">Riwayat tindakan admin</a>
      <a class="btn ghost" href="/scan">Buka scanner</a>
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
      <a class="btn ghost" href="/admin">Kembali</a></div>`,
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
  return dashboard(
    c,
    who,
    await tickets.counts(env),
    query,
    query ? await tickets.search(env, query) : [],
    notice,
  );
}

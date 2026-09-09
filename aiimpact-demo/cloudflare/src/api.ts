/**
 * Handlers for /api/*, served same-origin from aimpact.<domain>.
 *
 *   POST /api/redeem          {code}   -> {token, slug, remaining}
 *   POST /api/generate        {prompt} -> {job_id, remaining}
 *   GET  /api/status/{job_id}          -> {status, url?, message?}
 *   GET  /api/me                       -> {slug, url?, remaining}
 *
 * Generation is enqueued rather than performed here. Workers have no
 * wall-clock limit so it *could* run inline, but the queue is what caps
 * concurrent calls to Anthropic during the burst -- without it 200 submissions
 * become 200 simultaneous requests and a wall of 429s.
 */
import { bearer, sign, verify } from "./auth";
import { normalise, valid } from "./code";
import type { Env } from "./model";
import { CapReached, NotFound, Store } from "./store";

const MIN_PROMPT = 25;
const MAX_PROMPT = 4000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Every message a participant can see is a sentence in Indonesian saying what to do. */
function fault(status: number, message: string): Response {
  return json(status, { error: status, message });
}

const BUSY = "Server sedang sibuk. Coba lagi sebentar lagi.";
const EXPIRED = "Sesi Anda berakhir. Masukkan kode lagi.";
const UNKNOWN_CODE = "Kode tidak ditemukan. Periksa lembar peserta Anda.";

async function codeFrom(req: Request, env: Env): Promise<string | null> {
  const token = bearer(req.headers.get("authorization"));
  if (!token) return null;
  try {
    return await verify(env.SESSION_SECRET, token);
  } catch {
    return null;
  }
}

function remaining(count: number, max: number): number {
  return Math.max(0, max - count);
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const store = new Store(env.DB);
  const max = Number(env.MAX_GENERATIONS);

  if (!Number.isFinite(max) || max <= 0) {
    console.error("MAX_GENERATIONS invalid", env.MAX_GENERATIONS);
    return fault(500, BUSY);
  }

  // --- POST /redeem --------------------------------------------------------
  if (req.method === "POST" && path === "/redeem") {
    const body = await req.json<{ code?: string }>().catch(() => null);
    // Crockford normalisation: someone reading O for 0 or I for 1 off a
    // printed handout still gets in, rather than being told their own code
    // is wrong.
    const code = normalise(body?.code ?? "");
    if (!valid(code)) return fault(400, "Kode tidak terbaca. Periksa lembar peserta Anda.");

    try {
      const p = await store.redeem(code);
      return json(200, {
        token: await sign(env.SESSION_SECRET, p.code),
        slug: p.slug,
        remaining: remaining(p.generation_count, max),
      });
    } catch (err) {
      if (err instanceof NotFound) return fault(404, UNKNOWN_CODE);
      console.error("redeem", err);
      return fault(500, BUSY);
    }
  }

  // --- POST /generate ------------------------------------------------------
  if (req.method === "POST" && path === "/generate") {
    const code = await codeFrom(req, env);
    if (!code) return fault(401, EXPIRED);

    const body = await req.json<{ prompt?: string }>().catch(() => null);
    const prompt = body?.prompt?.trim() ?? "";
    if (prompt.length < MIN_PROMPT) {
      return fault(400, "Ceritakan sedikit lebih lengkap — nama usaha, menu, dan nomor WhatsApp.");
    }
    if (prompt.length > MAX_PROMPT) {
      return fault(400, "Cerita Anda terlalu panjang. Ringkas sedikit ya.");
    }

    let count: number;
    try {
      count = await store.countGeneration(code, max);
    } catch (err) {
      if (err instanceof CapReached) {
        return fault(429, "Anda sudah mencapai batas pembuatan. Hubungi panitia bila perlu tambahan.");
      }
      if (err instanceof NotFound) return fault(404, UNKNOWN_CODE);
      console.error("countGeneration", err);
      return fault(500, BUSY);
    }

    const jobId = crypto.randomUUID();
    try {
      await store.createJob(jobId, code);
      await env.QUEUE.send({ job_id: jobId, code, prompt });
    } catch (err) {
      // The count is already spent. Marking the job failed is what stops the
      // participant polling a job that will never be picked up.
      console.error("enqueue", err, jobId);
      await store.setJobStatus(jobId, "error", { message: "Gagal mengirim ke antrean." }).catch(() => {});
      return fault(500, "Gagal mengirim permintaan. Coba lagi.");
    }

    return json(202, { job_id: jobId, remaining: remaining(count, max) });
  }

  // --- GET /status/{job_id} ------------------------------------------------
  const status = /^\/status\/([A-Za-z0-9-]{1,64})$/.exec(path);
  if (req.method === "GET" && status) {
    try {
      const j = await store.job(status[1]!);
      return json(200, {
        status: j.status,
        ...(j.url ? { url: j.url } : {}),
        ...(j.message ? { message: j.message } : {}),
      });
    } catch (err) {
      if (err instanceof NotFound) return fault(404, "Permintaan tidak ditemukan.");
      console.error("status", err);
      return fault(500, BUSY);
    }
  }

  // --- GET /me -------------------------------------------------------------
  if (req.method === "GET" && path === "/me") {
    const code = await codeFrom(req, env);
    if (!code) return fault(401, EXPIRED);
    try {
      const p = await store.participant(code);
      return json(200, {
        slug: p.slug,
        ...(p.slug ? { url: `https://${p.slug}.${env.DOMAIN}` } : {}),
        remaining: remaining(p.generation_count, max),
      });
    } catch (err) {
      if (err instanceof NotFound) return fault(404, UNKNOWN_CODE);
      console.error("me", err);
      return fault(500, BUSY);
    }
  }

  return fault(404, "Alamat tidak dikenal.");
}

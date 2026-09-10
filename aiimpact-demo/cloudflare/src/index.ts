/**
 * Worker entry point. One Worker serves both hostnames; this dispatches.
 *
 *   aimpact.<domain>/          builder UI (static assets)
 *   aimpact.<domain>/api/*     handlers
 *   aimpact.<domain>/p/{slug}  a published page, by path
 *   {slug}.<domain>/           the same page, by subdomain
 *
 * Cloudflare routes only apply to proxied hostnames, so the grey-clouded apex
 * and www continue to resolve to the existing Hostinger site untouched.
 */
import { handle } from "./api";
import type { Env, QueueMessage } from "./model";
import { RESERVED } from "./slug";
import { Store } from "./store";

const APP_LABEL = "aimpact";

function notFound(): Response {
  return new Response("Halaman tidak ditemukan.", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function servePage(slug: string, env: Env): Promise<Response> {
  const html = await new Store(env.DB).page(slug);
  if (html === null) return notFound();

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Short, because a participant republishes and immediately shows the
      // result to someone. Long enough to absorb a burst of shares.
      "cache-control": "public, max-age=60, must-revalidate",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      // Defence in depth. The renderer emits no script, so this should never
      // block anything -- if it does, render.ts has a bug.
      "content-security-policy":
        "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    },
  });
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const label = url.hostname.toLowerCase().split(".")[0] ?? "";

    if (label === APP_LABEL) {
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        return handle(req, env);
      }
      // Path fallback for published pages. workers.dev has no wildcard
      // subdomains, so without this the flow can only be exercised after the
      // DNS migration -- making a risky, mail-affecting change a prerequisite
      // for testing rather than the last step.
      const preview = /^\/p\/([a-z0-9-]{1,63})\/?$/.exec(url.pathname);
      if (preview) return servePage(preview[1]!, env);

      return env.ASSETS.fetch(req);
    }

    // Reserved labels never map to a participant page. Duplicated in slug.ts,
    // which refuses to assign them (design §8.7).
    if (RESERVED.has(label)) return notFound();
    return servePage(label, env);
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    // One handler serves both queues; batch.queue says which.
    if (batch.queue.endsWith("-dlq")) {
      const { buryDeadLetter } = await import("./consumer");
      for (const msg of batch.messages) {
        await buryDeadLetter(msg.body, env);
        msg.ack(); // never retry a dead letter — that is how it got here
      }
      return;
    }

    const { consume } = await import("./consumer");
    for (const msg of batch.messages) {
      try {
        await consume(msg.body, env);
        msg.ack();
      } catch (err) {
        console.error("consume", err, msg.body.job_id);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, QueueMessage>;

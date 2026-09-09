/**
 * Queue consumer: turns a participant's prompt into a published page.
 *
 * The model writes the whole document — layout, palette, typography — so two
 * participants get visibly different sites. That difference is the product:
 * it is what makes someone believe the AI built something for *their* shop
 * rather than filling in a form.
 *
 * The cost is that untrusted markup gets published under the organisation's
 * domain. `./sanitize` strips it with a real parser, and the response headers
 * in index.ts refuse to execute whatever survives. See sanitize.ts for what
 * that does and does not protect against.
 *
 * Concurrency is capped by `max_concurrency` on the queue consumer in
 * wrangler.toml, not here — that cap is what keeps a 200-person burst from
 * becoming a wall of 429s.
 */
import Anthropic from "@anthropic-ai/sdk";

import type { Env, QueueMessage } from "./model";
import { SYSTEM } from "./prompt";
import { sanitize, SanitizeError } from "./sanitize";
import { make as makeSlug, unique as uniqueSlug } from "./slug";
import { SlugTaken, Store } from "./store";

/**
 * Effort is `medium`, raised from `low` when the model took over page design.
 *
 * Extracting fields was mechanical; choosing a palette and a layout that suit
 * a bengkel rather than a butik is not. This is the first dial to turn if the
 * pages look generic — before changing model.
 */
const EFFORT = "medium" as const;

/** A full HTML document runs to a few thousand tokens. Generous so nothing truncates. */
const MAX_TOKENS = 16000;

/** Raised when the participant, not the system, needs to act. */
export class ParticipantError extends Error {}

/**
 * Pulls the document out of the response.
 *
 * Models wrap HTML in a markdown fence often enough that stripping it is
 * routine rather than defensive, and a fence left in place renders as literal
 * backticks at the top of someone's shop page.
 */
export function extractHtml(text: string): string {
  const fenced = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();

  // Discard any preamble before the document actually starts.
  const start = body.search(/<!doctype html|<html[\s>]/i);
  return (start > 0 ? body.slice(start) : body).trim();
}

async function generate(env: Env, prompt: string): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT },
    // Byte-identical for every participant, so it caches after the first call
    // and reads back at roughly a tenth of the input price.
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: prompt }],
  });

  // Always check stop_reason before reading content: a safety decline arrives
  // as HTTP 200, not an exception.
  if (response.stop_reason === "refusal") {
    throw new ParticipantError(
      "Cerita Anda tidak dapat diproses. Coba tulis ulang dengan kalimat yang berbeda.",
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new ParticipantError("Cerita Anda terlalu panjang. Ringkas sedikit ya.");
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const html = extractHtml(text);
  if (!/<html[\s>]/i.test(html)) {
    throw new Error("model did not return an HTML document");
  }
  return html;
}

/**
 * Returns the participant's slug, claiming one on first publish.
 *
 * Permanent once assigned: it is in someone's WhatsApp history the moment it
 * is published, so a participant regenerating keeps the URL they already
 * shared even if the new page names the business differently.
 */
export async function resolveSlug(store: Store, code: string, name: string): Promise<string> {
  const p = await store.participant(code);
  if (p.slug) return p.slug;

  // Retry the whole claim, not just the suffix: losing the race means someone
  // else took the label between the free check and the write.
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = await uniqueSlug(name, (c) => store.slugFree(c));
    try {
      await store.claimSlug(code, candidate);
      return candidate;
    } catch (err) {
      if (!(err instanceof SlugTaken)) throw err;
    }
  }
  throw new Error(`could not claim a slug for ${JSON.stringify(name)}`);
}

export async function consume(msg: QueueMessage, env: Env): Promise<void> {
  const store = new Store(env.DB);
  await store.setJobStatus(msg.job_id, "running");

  try {
    const raw = await generate(env, msg.prompt);
    const { html, title } = await sanitize(raw);

    // The prompt asks for the business name in <title> and nothing else. If
    // the model returned something with no usable letters, fall back rather
    // than failing a page that is otherwise fine.
    let name = title;
    try {
      makeSlug(name);
    } catch {
      name = "usaha-jambi";
    }

    const slug = await resolveSlug(store, msg.code, name);
    const url = `https://${slug}.${env.DOMAIN}`;

    // One batch: the page and the job status move together, so a participant
    // is never shown a URL that 404s.
    await store.publish({ slug, html, jobId: msg.job_id, url });
  } catch (err) {
    if (err instanceof ParticipantError || err instanceof SanitizeError) {
      // Their input, not our fault. Terminal — retrying identical input would
      // spend another generation against the cap and fail the same way.
      await store.setJobStatus(msg.job_id, "error", { message: err.message });
      return;
    }
    // Ours. Rethrow so the consumer calls retry() rather than ack().
    console.error("generate", msg.job_id, err);
    throw err;
  }
}

/**
 * Queue consumer: turns a participant's prompt into a published page.
 *
 * Concurrency is capped by `max_concurrency` on the queue consumer in
 * wrangler.toml, not here. That cap is what keeps a 200-person burst from
 * becoming a wall of 429s.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import type { Env, QueueMessage, SiteContent } from "./model";
import { SYSTEM } from "./prompt";
import { page } from "./render";
import { make as makeSlug, unique as uniqueSlug } from "./slug";
import { SlugTaken, Store } from "./store";

/**
 * Effort is `low` deliberately, and it is not a cost decision.
 *
 * A participant is watching a spinner, and this is a short extraction-and-copy
 * task rather than a reasoning one — the workload shape where higher effort
 * buys little. Raise it if output quality disappoints; it is the first dial to
 * turn, before changing model.
 */
const EFFORT = "low" as const;

/** Output is ~700 tokens of JSON. Generous so nothing truncates mid-object. */
const MAX_TOKENS = 4000;

const Product = z.object({
  name: z.string(),
  price: z.string(),
  note: z.string().optional(),
});

const Content = z.object({
  business_name: z.string(),
  headline: z.string(),
  tagline: z.string(),
  about: z.string(),
  products: z.array(Product),
  cta_label: z.string(),
  wa_number: z.string(),
  address: z.string().optional(),
  hours: z.string().optional(),
});

/** Raised when the participant, not the system, needs to act. */
export class ParticipantError extends Error {}

async function generate(env: Env, prompt: string): Promise<SiteContent> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.parse({
    model: env.ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT, format: zodOutputFormat(Content) },
    // The system prompt is identical across all participants, so it caches
    // after the first call. Verify with usage.cache_read_input_tokens.
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: prompt }],
  });

  // Always check stop_reason before reading content. A safety decline arrives
  // as HTTP 200, not an exception. Server-side fallbacks are deliberately not
  // wired here: rerouting to another model to satisfy a request that was
  // declined is the wrong behaviour for a public workshop. Asking the
  // participant to rewrite is both simpler and more honest.
  if (response.stop_reason === "refusal") {
    throw new ParticipantError(
      "Cerita Anda tidak dapat diproses. Coba tulis ulang dengan kalimat yang berbeda.",
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new ParticipantError("Cerita Anda terlalu panjang. Ringkas sedikit ya.");
  }
  if (!response.parsed_output) {
    throw new Error("model returned no parseable output");
  }
  return response.parsed_output;
}

/**
 * Returns the participant's slug, claiming one on first publish.
 *
 * A slug is permanent once assigned: it is in someone's WhatsApp history the
 * moment it is published, so a participant regenerating keeps the URL they
 * already shared, even if they rename the business in the prompt.
 */
export async function resolveSlug(store: Store, code: string, businessName: string): Promise<string> {
  const p = await store.participant(code);
  if (p.slug) return p.slug;

  // Retry the whole claim, not just the suffix: losing the race means another
  // participant took the label between the free check and the write.
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = await uniqueSlug(businessName, (c) => store.slugFree(c));
    try {
      await store.claimSlug(code, candidate);
      return candidate;
    } catch (err) {
      if (!(err instanceof SlugTaken)) throw err;
    }
  }
  throw new Error(`could not claim a slug for ${JSON.stringify(businessName)}`);
}

export async function consume(msg: QueueMessage, env: Env): Promise<void> {
  const store = new Store(env.DB);
  await store.setJobStatus(msg.job_id, "running");

  try {
    const content = await generate(env, msg.prompt);

    // The model is told to copy the number verbatim, but a participant who
    // never wrote one leaves it empty, and render would reject the page after
    // the expensive call. Fail here with something actionable instead.
    if (!content.wa_number?.trim()) {
      throw new ParticipantError(
        "Nomor WhatsApp tidak ditemukan di cerita Anda. Tambahkan nomornya, lalu coba lagi.",
      );
    }

    // Slug comes from the business name; fall back to the headline if the
    // model left the name unusable (punctuation only, no letters).
    let source = content.business_name;
    try {
      makeSlug(source);
    } catch {
      source = content.headline;
    }

    const slug = await resolveSlug(store, msg.code, source);
    const html = page(content, new Date().getUTCFullYear());
    const url = `https://${slug}.${env.DOMAIN}`;

    // One batch: the page and the job status move together, so a participant
    // is never shown a URL that 404s.
    await store.publish({ slug, html, jobId: msg.job_id, url });
  } catch (err) {
    if (err instanceof ParticipantError) {
      // Their input, not our fault. Terminal — retrying identical input would
      // spend another generation against the cap and fail the same way.
      await store.setJobStatus(msg.job_id, "error", { message: err.message });
      return;
    }
    // Ours. Leave the job running so the queue retry can still succeed, and
    // rethrow so the consumer calls retry() rather than ack().
    console.error("generate", msg.job_id, err);
    throw err;
  }
}

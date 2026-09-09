/**
 * Queue consumer: turns a prompt into a published page.
 *
 * Steps, in order:
 *   1. mark the job running
 *   2. call the Messages API with structured output -- the model returns the
 *      fields of SiteContent, never markup (design §5.1)
 *   3. derive and claim a slug from the business name, or reuse the one the
 *      participant already holds
 *   4. render with ./render, which escapes every interpolation
 *   5. write the page and mark the job done in one batch
 *
 * Concurrency is capped by max_concurrency on the queue consumer in
 * wrangler.toml, not here -- that is what keeps the burst from becoming a wall
 * of 429s.
 */
import type { Env, QueueMessage } from "./model";
import { Store } from "./store";

export async function consume(msg: QueueMessage, env: Env): Promise<void> {
  const store = new Store(env.DB);
  await store.setJobStatus(msg.job_id, "running");

  // Step 2 onward pending: the Anthropic call, slug claim, render and publish.
  throw new Error("consumer: model call not implemented");
}

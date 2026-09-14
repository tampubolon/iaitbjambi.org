/**
 * Fallback page generator, used only when Anthropic cannot serve a request.
 *
 * This exists because of what happened on 2026-09-10: the Anthropic credit
 * balance emptied mid-burst and every subsequent generation failed with a
 * 400 that no amount of retrying could clear. The dead-letter path handled it
 * correctly — participants were told within seconds rather than left polling —
 * but "handled correctly" still means nobody gets a page. With 200 people in a
 * room and one shot at the demo, a second provider is worth more than a
 * tidier failure message.
 *
 * DeepSeek speaks the OpenAI chat-completions dialect, so this is a plain
 * fetch rather than another SDK in the bundle.
 *
 * It is deliberately NOT a load-balancing tier. Anthropic is asked first every
 * time and this is reached only when that fails, so the pages participants see
 * are the ones the prompt was written and measured against.
 */
import type { Env } from "./model";

const ENDPOINT = "https://api.deepseek.com/chat/completions";

/**
 * deepseek-chat caps output at 8,192 tokens, so the 16,000 used for Anthropic
 * is rejected outright. A measured page is ~1,939 tokens; this stays generous
 * without asking for more than the model will give.
 */
const MAX_TOKENS = 8000;

/** Network + generation, before the queue gives up on this attempt. */
const TIMEOUT_MS = 90_000;

export interface Completion {
  text: string;
  /** "stop" | "length" | "content_filter" | … — mapped by the caller. */
  finish: string;
}

/** True when a fallback is configured at all; absent key means Anthropic only. */
export function configured(env: Env): boolean {
  return Boolean(env.DEEPSEEK_API_KEY);
}

/**
 * Asks DeepSeek for a page.
 *
 * Returns the raw assistant text and the finish reason. Extraction, HTML
 * validation and sanitisation are the caller's job, so a page from here goes
 * through exactly the same checks as one from Anthropic — the security
 * boundary is sanitize.ts, and it must not depend on which provider answered.
 *
 * @throws Error when the API rejects the request or returns no content. The
 * caller treats that as a failed attempt and lets the queue retry.
 */
export async function complete(env: Env, system: string, prompt: string): Promise<Completion> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL || "deepseek-chat",
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    // Keep the body: a 402 here reads much like the Anthropic credit 400, and
    // during a session the difference between "out of money" and "wrong key"
    // decides what the panitia does next.
    const body = await response.text().catch(() => "");
    throw new Error(`deepseek ${response.status} ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const choice = data.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new Error("deepseek returned no content");

  const u = data.usage;
  console.log(
    JSON.stringify({
      at: "generation",
      provider: "deepseek",
      model: env.DEEPSEEK_MODEL || "deepseek-chat",
      stop: choice?.finish_reason ?? "unknown",
      in_tokens: u?.prompt_tokens ?? 0,
      out_tokens: u?.completion_tokens ?? 0,
    }),
  );

  return { text, finish: choice?.finish_reason ?? "stop" };
}

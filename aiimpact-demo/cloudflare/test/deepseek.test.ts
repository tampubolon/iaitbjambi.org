import { afterEach, describe, expect, it, vi } from "vitest";
import { complete, configured } from "../src/deepseek";
import type { Env } from "../src/model";

const env = { DEEPSEEK_API_KEY: "dsk-test", DEEPSEEK_MODEL: "deepseek-chat" } as unknown as Env;

function reply(body: unknown, status = 200) {
  return vi.fn(async (_url: string, _init: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

const page = { choices: [{ message: { content: "<html><body>hi</body></html>" }, finish_reason: "stop" }] };

afterEach(() => vi.unstubAllGlobals());

describe("configured", () => {
  it("is off without a key, so the fallback cannot fire by accident", () => {
    expect(configured({} as Env)).toBe(false);
    expect(configured(env)).toBe(true);
  });
});

describe("complete", () => {
  it("returns the assistant text and finish reason", async () => {
    vi.stubGlobal("fetch", reply(page));
    await expect(complete(env, "SYS", "warung soto")).resolves.toEqual({
      text: "<html><body>hi</body></html>",
      finish: "stop",
    });
  });

  it("sends the system prompt and the participant prompt as separate turns", async () => {
    const fetchMock = reply(page);
    vi.stubGlobal("fetch", fetchMock);
    await complete(env, "SYS", "warung soto");

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "warung soto" },
    ]);
    // 16,000 is the Anthropic budget and deepseek-chat rejects it outright.
    expect(body.max_tokens).toBeLessThanOrEqual(8192);
  });

  it("keeps the error body, because 402 here means the same as the Anthropic 400", async () => {
    vi.stubGlobal("fetch", reply({ error: { message: "Insufficient Balance" } }, 402));
    await expect(complete(env, "SYS", "x")).rejects.toThrow(/402.*Insufficient Balance/s);
  });

  it("treats a 200 with no content as a failure rather than publishing an empty page", async () => {
    vi.stubGlobal("fetch", reply({ choices: [{ message: {}, finish_reason: "stop" }] }));
    await expect(complete(env, "SYS", "x")).rejects.toThrow(/no content/);
  });
});

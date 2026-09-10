import { describe, expect, it, vi } from "vitest";
import { buryDeadLetter } from "../src/consumer";
import type { Env, QueueMessage } from "../src/model";

const msg: QueueMessage = { job_id: "job-1", code: "ABCD12", prompt: "..." };

/**
 * D1 stub capturing what the store would have written. buryDeadLetter builds
 * its own Store from env.DB, so the seam is the prepared statement.
 */
function fakeEnv(opts: { throws?: boolean } = {}): { env: Env; bound: unknown[][] } {
  const bound: unknown[][] = [];
  const stmt = {
    bind: (...args: unknown[]) => {
      bound.push(args);
      return {
        run: async () => {
          if (opts.throws) throw new Error("d1 unavailable");
          return { meta: { changes: 1 } };
        },
      };
    },
  };
  const env = { DB: { prepare: () => stmt } } as unknown as Env;
  return { env, bound };
}

describe("buryDeadLetter", () => {
  it("marks the job failed so the participant is told in seconds, not minutes", async () => {
    const { env, bound } = fakeEnv();
    await buryDeadLetter(msg, env);

    const args = bound.at(-1)!;
    expect(args).toContain("error");
    expect(args).toContain("job-1");
    // The message must say what to do, not name an internal failure.
    expect(args.some((a) => typeof a === "string" && /coba lagi/i.test(a))).toBe(true);
  });

  it("logs the job and code so failures can be counted during the session", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = fakeEnv();
    await buryDeadLetter(msg, env);

    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).toContain("dead_letter");
    expect(logged).toContain("job-1");
    expect(logged).toContain("ABCD12");
    spy.mockRestore();
  });

  it("never throws, because a throw here would retry a dead letter forever", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = fakeEnv({ throws: true });
    await expect(buryDeadLetter(msg, env)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

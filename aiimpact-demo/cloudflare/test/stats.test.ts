import { describe, expect, it } from "vitest";
import { bank } from "../src/assessment-bank";
import type { Result } from "../src/assessment";
import { compute, perHour, type StatsInput } from "../src/stats";

function result(kind: "pre" | "post", score: number, answers: Record<string, string> = {}): Result {
  return { kind, score, at: "2026-09-17T02:00:00Z", answers };
}

function input(over: Partial<StatsInput> = {}): StatsInput {
  return {
    tickets: [
      { code: "AAAAAA", status: "active", checkedAt: "2026-09-17T01:10:00Z" },
      { code: "BBBBBB", status: "active", checkedAt: "2026-09-17T03:05:00Z" },
      { code: "CCCCCC", status: "active", checkedAt: null },
      { code: "PANIT1", status: "active", checkedAt: "2026-09-17T01:00:00Z" },
      { code: "GONE01", status: "revoked", checkedAt: "2026-09-17T01:00:00Z" },
    ],
    panitia: new Set(["PANIT1"]),
    pre: new Map([
      ["AAAAAA", result("pre", 60)],
      ["BBBBBB", result("pre", 80)],
      ["CCCCCC", result("pre", 40)],
      ["PANIT1", result("pre", 100)],
    ]),
    post: new Map([
      ["AAAAAA", result("post", 90)],
      ["BBBBBB", result("post", 80)],
      ["GONE01", result("post", 10)],
    ]),
    lab: [
      { code: "AAAAAA", redeemed: true, generations: 3, built: true },
      { code: "BBBBBB", redeemed: true, generations: 0, built: false },
      { code: "CCCCCC", redeemed: false, generations: 0, built: false },
      { code: "PANIT1", redeemed: true, generations: 5, built: true },
    ],
    jobs: [
      { code: "AAAAAA", status: "done", createdAt: "2026-09-17 02:15:00" },
      { code: "AAAAAA", status: "done", createdAt: "2026-09-17 02:40:00" },
      { code: "AAAAAA", status: "error", createdAt: "2026-09-17 04:01:00" },
      { code: "PANIT1", status: "done", createdAt: "2026-09-17 02:00:00" },
    ],
    maxGenerations: 15,
    ...over,
  };
}

describe("compute", () => {
  const s = compute(input());

  it("counts active participants only, leaving out panitia and cancelled tickets", () => {
    expect(s.registered).toBe(3);
    expect(s.attended).toBe(2);
    expect(s.funnel.map((f) => f.value)).toEqual([3, 3, 2, 2, 1, 2]);
  });

  it("averages each test over participants only", () => {
    expect(s.pre.count).toBe(3);
    expect(s.pre.average).toBe(60);
    expect(s.pre.median).toBe(60);
    expect(s.post.count).toBe(2);
    expect(s.post.average).toBe(85);
  });

  it("compares scores only for people who sat both tests", () => {
    expect(s.paired).toEqual({
      count: 2,
      preAverage: 70,
      postAverage: 85,
      improved: 1,
      same: 1,
      declined: 0,
    });
    expect(s.postWithoutCheckIn).toBe(0);
  });

  it("buckets scores in steps of ten", () => {
    expect(s.pre.distribution).toHaveLength(11);
    expect(s.pre.distribution.find((b) => b.label === "60")?.value).toBe(1);
    expect(s.pre.distribution.reduce((n, b) => n + b.value, 0)).toBe(3);
  });

  it("summarises the builder without panitia usage", () => {
    expect(s.lab).toMatchObject({
      maxGenerations: 15,
      signedIn: 2,
      websites: 1,
      prompts: 3,
      failed: 1,
      attendedWithoutWebsite: 1,
    });
    expect(s.lab.slotsUsed.map((b) => b.value)).toEqual([2, 0, 0, 1]);
  });

  it("groups arrivals and prompts by WIB hour, keeping empty hours", () => {
    expect(s.arrivals).toEqual([
      { label: "08.00", value: 1 },
      { label: "09.00", value: 0 },
      { label: "10.00", value: 1 },
    ]);
    expect(s.lab.builds).toEqual([
      { label: "09.00", value: 2 },
      { label: "10.00", value: 0 },
      { label: "11.00", value: 1 },
    ]);
  });

  it("scores each question as the share answering correctly", () => {
    const first = bank("pre")[0]!;
    const r = compute(
      input({
        pre: new Map([
          ["AAAAAA", result("pre", 10, { [first.id]: first.a })],
          ["BBBBBB", result("pre", 0, { [first.id]: first.a === "A" ? "B" : "A" })],
        ]),
      }),
    );
    expect(r.pre.questions).toHaveLength(10);
    expect(r.pre.questions[0]?.correct).toBe(0.5);
    expect(r.post.questions.every((q) => q.correct === 0 || q.correct === 1)).toBe(true);
  });

  it("returns zeros rather than NaN when nobody has done anything", () => {
    const empty = compute(input({ pre: new Map(), post: new Map(), jobs: [] }));
    expect(empty.pre.average).toBe(0);
    expect(empty.pre.questions.every((q) => q.correct === 0)).toBe(true);
    expect(empty.paired.count).toBe(0);
    expect(empty.lab.builds).toEqual([]);
  });
});

describe("perHour", () => {
  it("labels with the date when the span crosses midnight WIB", () => {
    const out = perHour([Date.parse("2026-09-16T16:30:00Z"), Date.parse("2026-09-16T17:10:00Z")]);
    expect(out.map((b) => b.label)).toEqual(["16/09 23.00", "17/09 00.00"]);
  });

  it("does not pad days of empty hours for a stray timestamp", () => {
    const out = perHour([Date.parse("2026-09-10T01:00:00Z"), Date.parse("2026-09-17T01:00:00Z")]);
    expect(out).toHaveLength(2);
  });
});

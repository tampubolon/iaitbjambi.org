import { describe, expect, it } from "vitest";
import { resolveSlug } from "../src/consumer";
import { SlugTaken, type Store } from "../src/store";
import type { Participant } from "../src/model";

function participant(over: Partial<Participant> = {}): Participant {
  return {
    code: "ABCD12",
    slug: null,
    business_name: null,
    wa_number: null,
    generation_count: 1,
    redeemed_at: null,
    created_at: "2026-09-10",
    ...over,
  };
}

/** Minimal stand-in; only the three methods resolveSlug touches. */
function fakeStore(opts: {
  existing?: string | null;
  taken?: Set<string>;
  failClaims?: number;
}): { store: Store; claims: string[] } {
  const taken = opts.taken ?? new Set<string>();
  const claims: string[] = [];
  let failures = opts.failClaims ?? 0;

  const store = {
    async participant() {
      return participant({ slug: opts.existing ?? null });
    },
    async slugFree(s: string) {
      return !taken.has(s);
    },
    async claimSlug(_code: string, s: string) {
      claims.push(s);
      if (failures > 0) {
        failures--;
        taken.add(s); // the winner of the race now holds it
        throw new SlugTaken(s);
      }
    },
  } as unknown as Store;

  return { store, claims };
}

describe("resolveSlug", () => {
  it("returns the existing slug without claiming again", async () => {
    // A slug is in someone's WhatsApp history the moment it is published, so
    // regenerating must not move the participant to a new URL.
    const { store, claims } = fakeStore({ existing: "nasi-goreng-budi" });
    expect(await resolveSlug(store, "ABCD12", "Nama Baru Sekali")).toBe("nasi-goreng-budi");
    expect(claims).toHaveLength(0);
  });

  it("claims a fresh slug on first publish", async () => {
    const { store } = fakeStore({});
    expect(await resolveSlug(store, "ABCD12", "Warung Nasi Goreng Budi")).toBe(
      "warung-nasi-goreng-budi",
    );
  });

  it("appends a suffix when the label is already held", async () => {
    const { store } = fakeStore({ taken: new Set(["kopi-kita"]) });
    expect(await resolveSlug(store, "ABCD12", "Kopi Kita")).toBe("kopi-kita-2");
  });

  it("retries the whole claim when it loses a race", async () => {
    // slugFree said free, another participant won between check and write.
    const { store, claims } = fakeStore({ failClaims: 1 });
    expect(await resolveSlug(store, "ABCD12", "Kopi Kita")).toBe("kopi-kita-2");
    expect(claims).toEqual(["kopi-kita", "kopi-kita-2"]);
  });

  it("gives up rather than looping forever", async () => {
    const { store } = fakeStore({ failClaims: 99 });
    await expect(resolveSlug(store, "ABCD12", "Kopi Kita")).rejects.toThrow(/could not claim/);
  });
});

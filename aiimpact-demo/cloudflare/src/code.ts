/**
 * Participant access codes.
 *
 * Crockford base32: the digits and letters with I, L, O and U removed. The
 * omissions are the point — a code is printed on a handout and read across a
 * room, and 0/O and 1/I/L are the pairs people get wrong. U is dropped so the
 * alphabet cannot spell unfortunate words by accident.
 *
 * Six characters from 32 symbols is ~1.07 billion combinations. For 200 codes
 * that makes guessing irrelevant, which matters because the code is the only
 * credential — there is no password (design §5.7).
 */
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 6;

/** Generates one code using the platform CSPRNG. */
export function generate(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/**
 * Normalises what someone typed.
 *
 * Crockford's substitutions, applied so a participant who reads O for 0 or
 * writes lowercase still gets in. Hyphens and spaces are stripped because
 * people insert them when copying from paper.
 */
export function normalise(input: string): string {
  return String(input ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

/** Reports whether a normalised code is well formed. */
export function valid(input: string): boolean {
  const c = normalise(input);
  if (c.length !== CODE_LENGTH) return false;
  return [...c].every((ch) => ALPHABET.includes(ch));
}

/** Generates `n` distinct codes. */
export function generateMany(n: number): string[] {
  const set = new Set<string>();
  // Bounded so a broken CSPRNG fails loudly instead of spinning.
  for (let i = 0; set.size < n && i < n * 20; i++) set.add(generate());
  if (set.size < n) throw new Error(`could only generate ${set.size} of ${n} distinct codes`);
  return [...set];
}

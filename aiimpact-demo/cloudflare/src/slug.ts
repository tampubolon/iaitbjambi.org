/**
 * Turns a business name into the subdomain label its page is served from.
 *
 * The result becomes part of a hostname the owner reads aloud and types into
 * WhatsApp, so it must satisfy DNS rules while staying recognisable as their
 * own business name.
 */
export const MAX_LEN = 40;

/**
 * Labels that never become a participant slug -- infrastructure, or things
 * that would be mistaken for it.
 *
 * Deliberately duplicated in src/index.ts's host routing: one list rejects at
 * assignment, the other refuses to serve. Keep them in sync (design §8.7).
 */
export const RESERVED = new Set([
  "aimpact", "www", "api", "mail", "ftp", "admin", "cdn", "smtp", "imap",
  "app", "test", "staging", "dev", "static", "assets",
]);

export class SlugError extends Error {}

/**
 * Normalises a business name into a candidate label.
 *
 * Throws only when nothing usable survives. Callers should fall back to a
 * generated label rather than reject the participant.
 */
export function make(name: string): string {
  let out = "";
  let lastHyphen = true; // suppresses a leading hyphen

  for (const ch of String(name ?? "").trim().toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
      lastHyphen = false;
    } else if (/[\s\-_./,]/.test(ch)) {
      if (!lastHyphen && out.length > 0) {
        out += "-";
        lastHyphen = true;
      }
    }
    // Anything else -- punctuation, emoji, non-Latin script -- is dropped
    // rather than transliterated: a wrong transliteration is worse to read
    // aloud than a shorter name.
  }

  let s = out.replace(/^-+|-+$/g, "");
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN).replace(/-+$/, "");

  if (!s) throw new SlugError(`${JSON.stringify(name)} leaves no usable characters`);
  if (!/[a-z]/.test(s)) throw new SlugError(`${JSON.stringify(name)} has no letters`);
  return s;
}

/**
 * Returns the first free label derived from name, appending -2, -3 and so on.
 * Two participants naming their warung the same thing is expected.
 */
export async function unique(
  name: string,
  free: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const base = make(name);
  for (let i = 1; i <= 50; i++) {
    const cand = i === 1 ? base : `${base}-${i}`;
    if (RESERVED.has(cand)) continue;
    if (await free(cand)) return cand;
  }
  throw new SlugError(`no label free for ${JSON.stringify(name)} after 50 attempts`);
}

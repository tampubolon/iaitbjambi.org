/**
 * Short-lived session tokens issued when a participant redeems their code.
 *
 * Deliberately not a JWT library: one claim, a few hours, a single-day event.
 * An HMAC over "code:expiry" is the entire requirement, and a dependency with
 * an algorithm-confusion history is not an improvement at this size.
 *
 * Unlike the Go original this is async — WebCrypto has no synchronous HMAC.
 * `crypto.subtle.verify` is used rather than comparing strings, so the
 * comparison is constant time and there is no timing oracle on the signature.
 */
const TTL_SECONDS = 12 * 60 * 60;

export class TokenError extends Error {}

const encoder = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
  if (secret.length < 16) throw new TokenError(`secret too short (${secret.length} bytes)`);
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Issues a token for a participant code. */
export async function sign(secret: string, code: string, nowMs = Date.now()): Promise<string> {
  const payload = `${code}:${Math.floor(nowMs / 1000) + TTL_SECONDS}`;
  const body = b64url(encoder.encode(payload));
  const mac = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(body));
  return `${body}.${b64url(mac)}`;
}

/** Returns the code carried by a valid, unexpired token. */
export async function verify(secret: string, token: string, nowMs = Date.now()): Promise<string> {
  const dot = token.indexOf(".");
  if (dot < 1) throw new TokenError("malformed token");

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let ok: boolean;
  try {
    ok = await crypto.subtle.verify("HMAC", await key(secret), unb64url(sig), encoder.encode(body));
  } catch {
    throw new TokenError("malformed token");
  }
  if (!ok) throw new TokenError("bad signature");

  let payload: string;
  try {
    payload = new TextDecoder().decode(unb64url(body));
  } catch {
    throw new TokenError("malformed token");
  }

  const sep = payload.lastIndexOf(":");
  if (sep < 1) throw new TokenError("malformed token");

  const code = payload.slice(0, sep);
  const exp = Number(payload.slice(sep + 1));
  if (!code || !Number.isFinite(exp)) throw new TokenError("malformed token");
  if (Math.floor(nowMs / 1000) > exp) throw new TokenError("token expired");

  return code;
}

/** Pulls a token out of an Authorization header. */
export function bearer(header: string | null): string {
  if (!header) return "";
  const m = /^bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() ?? "";
}

/**
 * QR rendering, in two formats, from one module matrix.
 *
 * Both are generated here rather than by a QR web service, because the payload
 * is a bearer token for someone's ticket and handing it to a third party to
 * draw would put it in that party's logs (PRD 4.1).
 *
 *   SVG  — the ticket page. Crisp at any size, no encoder, no raster artefacts
 *          on the high-DPI phone screens people will actually scan from.
 *   PNG  — the Google Sheets distribution template. IMAGE() reads PNG/JPG/GIF
 *          and cannot render SVG, so the Sheet column needs a raster.
 *
 * Error correction is M. Higher levels survive more damage but pack the same
 * payload into more modules, and a denser code is harder to read from a
 * screenshot at arm's length under venue lighting — which is the actual
 * failure mode here, not a torn ticket.
 */
import qrcode from "qrcode-generator";

/** Quiet zone in modules. The spec requires 4; less and some readers refuse. */
const QUIET = 4;

function matrix(text: string): { size: number; dark: (r: number, c: number) => boolean } {
  // Type 0 = auto-select the smallest version that fits the payload.
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return { size: q.getModuleCount(), dark: (r, c) => q.isDark(r, c) };
}

/**
 * Renders the code as an SVG document.
 *
 * One `<path>` of rectangles rather than one element per module: a 33x33 code
 * is over a thousand modules, and a thousand `<rect>` elements is a slow parse
 * on a cheap phone for an identical picture.
 */
export function svg(text: string, px = 320): string {
  const { size, dark } = matrix(text);
  const total = size + QUIET * 2;

  let d = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (dark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="Kode QR tiket">` +
    `<rect width="${total}" height="${total}" fill="#fff"/>` +
    `<path d="${d}" fill="#000"/>` +
    `</svg>`
  );
}

// --- PNG ---------------------------------------------------------------
//
// A hand-rolled encoder, because the alternative is pulling a raster library
// into a Worker to draw black squares. A QR is 1-bit and tiny, so the whole
// encoder is a few dozen lines: 1-bit greyscale, no compression beyond deflate's
// "stored" block type, which is valid zlib and costs a few KB we do not care
// about at this size.

function crcTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC = crcTable();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const name = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  const body = concat([name, data]);
  return concat([u32(data.length), body, u32(crc32(body))]);
}

/** zlib stream using stored (uncompressed) deflate blocks. */
function zlib(raw: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])]; // CMF/FLG
  const MAX = 65535;
  for (let at = 0; at < raw.length; at += MAX) {
    const slice = raw.subarray(at, Math.min(at + MAX, raw.length));
    const last = at + MAX >= raw.length ? 1 : 0;
    const len = slice.length;
    blocks.push(new Uint8Array([last, len & 255, len >>> 8, ~len & 255, (~len >>> 8) & 255]));
    blocks.push(slice);
  }
  blocks.push(u32(adler32(raw)));
  return concat(blocks);
}

/**
 * Renders the code as a 1-bit greyscale PNG.
 *
 * `scale` is pixels per module and `quiet` the margin in modules, so the image
 * is exact — no resampling, every module a whole number of pixels, which is
 * what keeps a small code scannable.
 */
export function png(text: string, scale = 8): Uint8Array {
  const { size, dark } = matrix(text);
  const total = (size + QUIET * 2) * scale;

  // 1 bit per pixel, because that is exactly what a QR is. At 8 bits the same
  // image is eight times larger, and the Sheets template fetches 200 of them.
  // Bit set = white, clear = black. One filter byte (0 = None) per row.
  const rowBytes = Math.ceil(total / 8);
  const raw = new Uint8Array(total * (rowBytes + 1));
  for (let y = 0; y < total; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0;
    const row = Math.floor(y / scale) - QUIET;
    for (let x = 0; x < total; x++) {
      const col = Math.floor(x / scale) - QUIET;
      const on = row >= 0 && row < size && col >= 0 && col < size && dark(row, col);
      if (!on) raw[rowStart + 1 + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }

  const ihdr = concat([
    u32(total),
    u32(total),
    new Uint8Array([1, 0, 0, 0, 0]), // 1-bit, greyscale, no interlace
  ]);

  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

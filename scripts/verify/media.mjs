/**
 * Binary fixtures: a real PDF and a real PNG, built here rather than committed.
 *
 * Both carry a caller-supplied token, so a scenario can tell "the model read
 * the file" apart from "the model guessed". They are hand-encoded because the
 * point of the check is the bytes surviving the transport: a fixture produced
 * by a library that silently emitted something malformed would read as "the
 * bridge dropped the attachment".
 *
 * Shared by fixtures.mjs (scenario workspaces) and probe.mjs (capability
 * probes) so both exercise the same bytes.
 */

import zlib from "node:zlib";

/**
 * A minimal, uncompressed, single-page PDF carrying one line of text.
 *
 * The xref offsets have to be exact for a strict parser, so they are measured
 * from the document as it is built rather than assumed.
 */
export function buildPdf(text) {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/**
 * Continuous, antialiased strokes keep this transport fixture from becoming a
 * pixel-font OCR test. Block glyphs with diagonal-only contacts led to D/0 and
 * 0/O misreads even when the attachment bytes arrived intact. Curves, a slashed
 * zero and a straight D spine distinguish those characters without changing
 * token entropy or adding an answer in image metadata. Coordinates use a 6x8
 * em; M/L/Q are move, line and quadratic curve commands.
 */
const GLYPHS = {
  A: "M0,8 L3,0 L6,8 M1,5.5 L5,5.5",
  B: "M0,8 L0,0 L3,0 Q6,0 6,2 Q6,4 3,4 L0,4 M3,4 Q6,4 6,6 Q6,8 3,8 L0,8",
  C: "M6,1 Q5,0 3,0 Q0,0 0,4 Q0,8 3,8 Q5,8 6,7",
  D: "M0,8 L0,0 L2.5,0 Q6,0 6,4 Q6,8 2.5,8 L0,8",
  E: "M6,0 L0,0 L0,8 L6,8 M0,4 L5,4",
  F: "M6,0 L0,0 L0,8 M0,4 L5,4",
  G: "M6,1 Q5,0 3,0 Q0,0 0,4 Q0,8 3,8 Q5,8 6,7 L6,4.5 L3.5,4.5",
  H: "M0,0 L0,8 M6,0 L6,8 M0,4 L6,4",
  I: "M0,0 L6,0 M3,0 L3,8 M0,8 L6,8",
  J: "M1,0 L6,0 M5,0 L5,6 Q5,8 2.5,8 Q0,8 0,6",
  K: "M0,0 L0,8 M6,0 L0,5 M2.5,3 L6,8",
  L: "M0,0 L0,8 L6,8",
  M: "M0,8 L0,0 L3,4 L6,0 L6,8",
  N: "M0,8 L0,0 L6,8 L6,0",
  O: "M3,0 Q0,0 0,4 Q0,8 3,8 Q6,8 6,4 Q6,0 3,0",
  P: "M0,8 L0,0 L3,0 Q6,0 6,2 Q6,4 3,4 L0,4",
  Q: "M3,0 Q0,0 0,4 Q0,8 3,8 Q6,8 6,4 Q6,0 3,0 M3.5,5.5 L6,8",
  R: "M0,8 L0,0 L3,0 Q6,0 6,2 Q6,4 3,4 L0,4 M3,4 L6,8",
  S: "M6,1 Q5,0 3,0 Q0,0 0,2 Q0,3.5 3,4 Q6,4.5 6,6 Q6,8 3,8 Q1,8 0,7",
  T: "M0,0 L6,0 M3,0 L3,8",
  U: "M0,0 L0,5 Q0,8 3,8 Q6,8 6,5 L6,0",
  V: "M0,0 L3,8 L6,0",
  W: "M0,0 L1,8 L3,4 L5,8 L6,0",
  X: "M0,0 L6,8 M6,0 L0,8",
  Y: "M0,0 L3,4 L6,0 M3,4 L3,8",
  Z: "M0,0 L6,0 L0,8 L6,8",
  0: "M3,0 Q0,0 0,4 Q0,8 3,8 Q6,8 6,4 Q6,0 3,0 M1,6.5 L5,1.5",
  1: "M1,2 L3,0 L3,8 M0,8 L6,8",
  2: "M0,1.5 Q1,0 3,0 Q6,0 6,2 Q6,3.5 3,5.5 L0,8 L6,8",
  3: "M0,1 Q1,0 3,0 Q6,0 6,2 Q6,4 3,4 L2,4 M3,4 Q6,4 6,6 Q6,8 3,8 Q1,8 0,7",
  4: "M4.5,8 L4.5,0 L0,5.5 L6,5.5",
  5: "M6,0 L0,0 L0,3.5 L3,3.5 Q6,3.5 6,6 Q6,8 3,8 Q1,8 0,7",
  6: "M5.5,0.5 Q4.5,0 3,0 Q0,0 0,5 Q0,8 3,8 Q6,8 6,5.5 Q6,3 3,3 Q1,3 0,5",
  7: "M0,0 L6,0 L2,8",
  8: "M3,4 Q0,4 0,2 Q0,0 3,0 Q6,0 6,2 Q6,4 3,4 Q0,4 0,6 Q0,8 3,8 Q6,8 6,6 Q6,4 3,4",
  9: "M0.5,7.5 Q1.5,8 3,8 Q6,8 6,3 Q6,0 3,0 Q0,0 0,2.5 Q0,5 3,5 Q5,5 6,3",
  "-": "M0,4 L6,4",
};

function glyphSegments(path) {
  const tokens = path.match(/[MLQ]|\d+(?:\.\d+)?/g);
  const segments = [];
  let x = 0;
  let y = 0;
  const line = (nextX, nextY) => {
    segments.push([x, y, nextX, nextY]);
    x = nextX;
    y = nextY;
  };
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++];
    const nextX = Number(tokens[i++]);
    const nextY = Number(tokens[i++]);
    if (command === "M") {
      x = nextX;
      y = nextY;
    } else if (command === "L") {
      line(nextX, nextY);
    } else {
      const endX = Number(tokens[i++]);
      const endY = Number(tokens[i++]);
      const startX = x;
      const startY = y;
      for (let step = 1; step <= 16; step += 1) {
        const t = step / 16;
        const u = 1 - t;
        line(u * u * startX + 2 * u * t * nextX + t * t * endX,
          u * u * startY + 2 * u * t * nextY + t * t * endY);
      }
    }
  }
  return segments;
}

export function buildPng(text) {
  const scale = 8;
  const pad = 32;
  const advance = 9;
  const radius = 3;
  const chars = [...text.toUpperCase()].filter((c) => GLYPHS[c] || c === " ");
  const width = pad * 2 + chars.length * advance * scale;
  const height = pad * 2 + 9 * scale;

  // White canvas, black strokes with a one-pixel antialias, RGB, filter none.
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride, 0xff);
  for (let y = 0; y < height; y += 1) raw[y * stride] = 0;

  chars.forEach((char, index) => {
    if (!GLYPHS[char]) return;
    const originX = pad + (index * advance + 0.5) * scale;
    const originY = pad + 0.5 * scale;
    for (const [x0, y0, x1, y1] of glyphSegments(GLYPHS[char])) {
      const ax = originX + x0 * scale;
      const ay = originY + y0 * scale;
      const bx = originX + x1 * scale;
      const by = originY + y1 * scale;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      for (let y = Math.floor(Math.min(ay, by) - radius - 1); y <= Math.ceil(Math.max(ay, by) + radius + 1); y += 1) {
        for (let x = Math.floor(Math.min(ax, bx) - radius - 1); x <= Math.ceil(Math.max(ax, bx) + radius + 1); x += 1) {
          const t = Math.max(0, Math.min(1, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / lengthSquared));
          const distance = Math.hypot(x + 0.5 - ax - t * dx, y + 0.5 - ay - t * dy);
          const shade = Math.round(255 * Math.max(0, Math.min(1, distance - radius + 0.5)));
          const offset = y * stride + 1 + x * 3;
          const value = Math.min(raw[offset], shade);
          raw.fill(value, offset, offset + 3);
        }
      }
    }
  });

  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

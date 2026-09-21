import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";

import { buildPng } from "../scripts/verify/media.mjs";

const SCALE = 8;
const PAD = 32;
const GLYPH_WIDTH = 7;
const GLYPH_HEIGHT = 9;
const ADVANCE = GLYPH_WIDTH + 2;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodePng(text) {
  const png = buildPng(text);
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const size = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + size);
    assert.equal(png.readUInt32BE(offset + 8 + size), crc32(png.subarray(offset + 4, offset + 8 + size)));
    chunks.push({ type, data });
    offset += size + 12;
  }
  assert.equal(offset, png.length);
  assert.deepEqual(chunks.map(({ type }) => type), ["IHDR", "IDAT", "IEND"]);
  const header = chunks[0].data;
  assert.deepEqual([...header.subarray(8)], [8, 2, 0, 0, 0]);
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const raw = zlib.inflateSync(chunks[1].data);
  const stride = width * 3 + 1;
  assert.equal(raw.length, stride * height);
  for (let y = 0; y < height; y += 1) assert.equal(raw[y * stride], 0);
  return { width, height, pixel: (x, y) => raw[y * stride + 1 + x * 3] };
}

function inkAt(image, x, y) {
  return image.pixel(PAD + Math.round((x + 0.5) * SCALE), PAD + Math.round((y + 0.5) * SCALE)) < 128;
}

test("zero has a diagonal slash distinct from O, D, B and 8", () => {
  const zero = decodePng("0");
  for (const [x, y] of [[2, 5.25], [3, 4], [4, 2.75]]) assert.ok(inkAt(zero, x, y));
  assert.ok(!inkAt(decodePng("O"), 3, 4));
  assert.ok(!inkAt(decodePng("D"), 3, 4));
  assert.ok(!inkAt(decodePng("B"), 2, 5.25));
  assert.ok(!inkAt(decodePng("8"), 2, 5.25));
});

test("D has a continuous straight spine and a curved closed right side, unlike 0 or C", () => {
  const d = decodePng("D");
  for (let y = 0; y <= 8; y += 0.25) assert.ok(inkAt(d, 0, y), `broken spine at ${y}`);
  assert.ok(inkAt(d, 6, 4));
  assert.ok(!inkAt(decodePng("0"), 0, 1));
  assert.ok(!inkAt(decodePng("C"), 6, 4));
});

test("B has a continuous spine and two open counters, distinct from 3", () => {
  const b = decodePng("B");
  for (let y = 0; y <= 8; y += 0.25) assert.ok(inkAt(b, 0, y));
  assert.ok(inkAt(b, 3, 4));
  assert.ok(!inkAt(b, 3, 2));
  assert.ok(!inkAt(b, 3, 6));
  assert.ok(!inkAt(decodePng("3"), 0, 4));
});

test("G has an open upper right side and an inward crossbar", () => {
  const g = decodePng("G");
  assert.ok(!inkAt(g, 6, 2.5));
  for (let x = 3.5; x <= 6; x += 0.25) assert.ok(inkAt(g, x, 4.5));
  assert.notDeepEqual(buildPng("G"), buildPng("S"));
});

test("glyph strokes are connected, antialiased and unique rather than diagonal-only pixel blocks", () => {
  const signatures = new Set();
  for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-") {
    const image = decodePng(char);
    const ink = new Set();
    let antialiased = false;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const value = image.pixel(x, y);
        if (value < 128) ink.add(y * image.width + x);
        if (value > 0 && value < 255) antialiased = true;
      }
    }
    assert.ok(ink.size > 100, `empty glyph ${char}`);
    signatures.add([...ink].join(","));
    // Four-connected foreground catches the disconnected diagonal blocks that
    // made the previous fixture ambiguous without depending on its font grid.
    const pending = [ink.values().next().value];
    ink.delete(pending[0]);
    while (pending.length) {
      const point = pending.pop();
      for (const adjacent of [point - 1, point + 1, point - image.width, point + image.width]) {
        if (ink.delete(adjacent)) pending.push(adjacent);
      }
    }
    assert.equal(ink.size, 0, `disconnected stroke in ${char}`);
    if (char !== "-") assert.ok(antialiased, `missing antialias in ${char}`);
  }
  assert.equal(signatures.size, 37);
});

test("all token glyphs are visible and separated, with no text metadata in the PNG", () => {
  for (const token of ["IMGTAG30CDC4", "IMGTAG19D4C3", "IMGTAG82E07E", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"]) {
    const image = decodePng(token);
    assert.equal(image.width, PAD * 2 + token.length * ADVANCE * SCALE);
    assert.equal(image.height, PAD * 2 + GLYPH_HEIGHT * SCALE);
    for (let index = 0; index < token.length; index += 1) {
      let ink = 0;
      const start = PAD + index * ADVANCE * SCALE;
      const gapStart = start + GLYPH_WIDTH * SCALE;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = start; x < gapStart; x += 1) if (image.pixel(x, y) < 128) ink += 1;
        for (let x = gapStart; x < gapStart + 2 * SCALE; x += 1) assert.equal(image.pixel(x, y), 255);
      }
      assert.ok(ink > 100, `missing ${token[index]}`);
    }
    for (let x = 0; x < image.width; x += 1) {
      assert.equal(image.pixel(x, PAD - 1), 255);
      assert.equal(image.pixel(x, image.height - PAD), 255);
    }
    assert.deepEqual(buildPng(token), buildPng(token), "fixtures must render deterministically");
  }
});

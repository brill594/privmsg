import test from "node:test";
import assert from "node:assert/strict";

import { buildQrSvgData, encodeQrMatrix } from "../frontend/lib/qrcode.js";

test("encodes a standard privmsg share link into a valid QR matrix", () => {
  const sampleLink = "https://privmsg.example.com/m/0123456789abcdef01234567#ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop";
  const result = encodeQrMatrix(sampleLink);

  assert.equal(result.size, 17 + 4 * result.version);
  assert.ok(result.version >= 1 && result.version <= 15);
  assert.equal(result.modules.length, result.size);

  // Verify top-left 7x7 finder pattern outer ring and 3x3 center
  for (let i = 0; i < 7; i += 1) {
    assert.equal(result.modules[0][i], 1);
    assert.equal(result.modules[6][i], 1);
    assert.equal(result.modules[i][0], 1);
    assert.equal(result.modules[i][6], 1);
  }
  for (let r = 2; r <= 4; r += 1) {
    for (let c = 2; c <= 4; c += 1) {
      assert.equal(result.modules[r][c], 1);
    }
  }

  // Verify dark module at (size - 8, 8)
  assert.equal(result.modules[result.size - 8][8], 1);
});

test("builds SVG path data with quiet zone for short and long URLs", () => {
  const shortSvg = buildQrSvgData("https://a.co/m/1#k", 2);
  assert.equal(shortSvg.viewBoxSize, shortSvg.size + 4);
  assert.ok(shortSvg.path.startsWith("M"));

  const longUrl = `https://privmsg.selfhosted.example.org/m/abcdef0123456789abcdef01#${"a".repeat(160)}`;
  const longSvg = buildQrSvgData(longUrl, 2);
  assert.ok(longSvg.size > shortSvg.size);
  assert.equal(longSvg.viewBoxSize, longSvg.size + 4);
  assert.ok(longSvg.path.length > 100);
});

test("throws when input exceeds QR capacity", () => {
  assert.throws(() => encodeQrMatrix("x".repeat(500)), /too long/i);
});

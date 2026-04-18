import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TTL_SECONDS,
  DEFAULT_READ_LIMIT,
  MAX_READ_LIMIT,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  clampReadLimit,
  clampTtlSeconds,
  getPreviewKind,
  isAllowedAttachment,
  isValidMessageId
} from "../src/shared.js";

test("allows supported attachment types", () => {
  assert.equal(isAllowedAttachment({ name: "photo.png", type: "image/png" }), true);
  assert.equal(isAllowedAttachment({ name: "clip.mov", type: "video/quicktime" }), true);
  assert.equal(isAllowedAttachment({ name: "note.txt", type: "" }), true);
  assert.equal(isAllowedAttachment({ name: "private-key.pk8", type: "application/pkcs8" }), true);
  assert.equal(isAllowedAttachment({ name: "private-key.pk8", type: "application/octet-stream" }), true);
});

test("rejects unsupported attachment types", () => {
  assert.equal(isAllowedAttachment({ name: "script.js", type: "application/javascript" }), false);
  assert.equal(isAllowedAttachment({ name: "vector.svg", type: "image/svg+xml" }), false);
  assert.equal(isAllowedAttachment({ name: "archive.zip", type: "application/zip" }), false);
  assert.equal(isAllowedAttachment({ name: "note.txt", type: "application/octet-stream" }), false);
});

test("computes preview types", () => {
  assert.equal(getPreviewKind({ name: "photo.jpg", type: "image/jpeg" }), "image");
  assert.equal(getPreviewKind({ name: "movie.webm", type: "video/webm" }), "video");
  assert.equal(getPreviewKind({ name: "doc.txt", type: "text/plain" }), "text");
  assert.equal(getPreviewKind({ name: "paper.pdf", type: "application/pdf" }), "pdf");
  assert.equal(getPreviewKind({ name: "private-key.pk8", type: "application/pkcs8" }), "download");
});

test("clamps ttl to service bounds", () => {
  assert.equal(clampTtlSeconds("bad"), DEFAULT_TTL_SECONDS);
  assert.equal(clampTtlSeconds(MIN_TTL_SECONDS - 1), MIN_TTL_SECONDS);
  assert.equal(clampTtlSeconds(MAX_TTL_SECONDS + 1), MAX_TTL_SECONDS);
});

test("clamps read limit to service bounds", () => {
  assert.equal(clampReadLimit("bad"), DEFAULT_READ_LIMIT);
  assert.equal(clampReadLimit(0), DEFAULT_READ_LIMIT);
  assert.equal(clampReadLimit(MAX_READ_LIMIT + 1), MAX_READ_LIMIT);
});

test("validates message ids", () => {
  assert.equal(isValidMessageId("abc"), false);
  assert.equal(isValidMessageId("bLsyit8XcUZjbyM4K2v4pw"), true);
});

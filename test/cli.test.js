import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createShare } from "../cli/lib/client.js";
import { base64UrlDecode, decryptJsonValue, deriveAccessKeyMaterial } from "../frontend/lib/privmsg.js";

const cliPath = fileURLToPath(new URL("../cli/bin/privmsg.js", import.meta.url));

test("persists a user's default deployment, allows temporary overrides, and resets it", async (t) => {
  const configHome = await mkdtemp(join(tmpdir(), "privmsg-config-test-"));
  t.after(() => rm(configHome, { recursive: true, force: true }));
  const mockFetch = `globalThis.fetch = async (url) => {
    if (new URL(url).pathname.endsWith('/api/create-bootstrap')) {
      return Response.json({id: 'test-message-id-0123456789', serverKeyShare: 'A'.repeat(43)});
    }
    return Response.json({ok: true}, {status: 201});
  };`;
  const run = (...args) => {
    const result = spawnSync(process.execPath, [
      "--import", `data:text/javascript,${encodeURIComponent(mockFetch)}`, cliPath, ...args
    ], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: configHome } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  assert.equal(run("config", "get", "base-url"), "https://privmsg.cc");
  run("config", "set", "base-url", "https://self-hosted.example.com");
  assert.equal(run("config", "get", "base-url"), "https://self-hosted.example.com/");
  assert.match(run("create", "secret"), /^https:\/\/self-hosted\.example\.com\/m\//);
  for (const option of ["--base-url", "--server"]) {
    assert.match(run("create", option, "https://temporary.example.com", "secret"), /^https:\/\/temporary\.example\.com\/m\//);
  }
  const config = JSON.parse(await readFile(join(configHome, "privmsg", "config.json"), "utf8"));
  assert.deepEqual(config, { baseUrl: "https://self-hosted.example.com/" });
  run("config", "reset", "base-url");
  assert.match(run("create", "secret"), /^https:\/\/privmsg\.cc\/m\//);
});

test("creates a CLI share that follows the browser decryption protocol", async () => {
  const id = "test-message-id-0123456789";
  const serverKeyShare = Buffer.alloc(32, 7).toString("base64url");
  let uploadedMetadata;
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname === "/api/create-bootstrap") {
      return Response.json({ id, serverKeyShare });
    }

    uploadedMetadata = JSON.parse(init.body.get("metadata"));
    return Response.json(
      {
        ok: true,
        id,
        expiresAt: "2026-09-22T00:00:00.000Z",
        maxReads: uploadedMetadata.maxReads
      },
      { status: 201 }
    );
  };

  const result = await createShare({
    message: "agent-created secret",
    server: "https://example.com",
    expiresInSeconds: 3600,
    maxReads: 2,
    fetchImpl
  });

  const shareUrl = new URL(result.shareUrl);
  const localKeyShare = shareUrl.hash.slice(1);
  const accessKeyMaterial = await deriveAccessKeyMaterial(
    base64UrlDecode(localKeyShare),
    base64UrlDecode(serverKeyShare),
    id
  );
  const plaintext = await decryptJsonValue(
    uploadedMetadata.payload.ciphertext,
    uploadedMetadata.payload.iv,
    accessKeyMaterial,
    id,
    "payload"
  );

  assert.equal(shareUrl.pathname, `/m/${id}`);
  assert.equal(localKeyShare.length, 43);
  assert.equal(uploadedMetadata.totalSize, 0);
  assert.equal(uploadedMetadata.maxReads, 2);
  assert.deepEqual(plaintext, {
    version: 1,
    message: "agent-created secret",
    attachments: []
  });
});

test("uses a custom base URL for self-hosted API calls and share links", async () => {
  const id = "test-message-id-0123456789";
  const serverKeyShare = Buffer.alloc(32, 7).toString("base64url");
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url.toString());
    if (new URL(url).pathname === "/api/create-bootstrap") {
      return Response.json({ id, serverKeyShare });
    }
    return Response.json({ ok: true, id }, { status: 201 });
  };

  const result = await createShare({
    message: "self-hosted secret",
    baseUrl: "https://privmsg.example.com",
    fetchImpl
  });

  assert.deepEqual(requestedUrls, [
    "https://privmsg.example.com/api/create-bootstrap",
    "https://privmsg.example.com/api/create"
  ]);
  assert.match(result.shareUrl, /^https:\/\/privmsg\.example\.com\/m\/test-message-id-0123456789#/);
});

test("accepts the --base-url CLI option", () => {
  const result = spawnSync(process.execPath, [cliPath, "create", "--base-url", "http://example.com", "secret"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--base-url must use HTTPS unless it points to localhost/);
  assert.doesNotMatch(result.stderr, /unknown option/);
});

test("surfaces server throttling without retrying creation", async () => {
  const id = "test-message-id-0123456789";
  const serverKeyShare = Buffer.alloc(32, 7).toString("base64url");
  let createRequests = 0;
  const fetchImpl = async (url) => {
    if (new URL(url).pathname === "/api/create-bootstrap") {
      return Response.json({ id, serverKeyShare });
    }

    createRequests += 1;
    return Response.json(
      {
        error: "rate_limit_exceeded",
        message: "Too many message creation requests"
      },
      {
        status: 429,
        headers: {
          "Retry-After": "60"
        }
      }
    );
  };

  await assert.rejects(
    createShare({
      message: "secret",
      fetchImpl
    }),
    /Too many message creation requests\. Retry after 60 seconds\./
  );
  assert.equal(createRequests, 1);
});

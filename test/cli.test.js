import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_TOTAL_SIZE_BYTES, createShare } from "../cli/lib/client.js";
import { base64UrlDecode, decryptBytes, decryptJsonValue, deriveAccessKeyMaterial } from "../frontend/lib/privmsg.js";

import { MAX_TOTAL_SIZE_BYTES as WEB_MAX_TOTAL_SIZE_BYTES } from "../src/shared.js";

const cliPath = fileURLToPath(new URL("../cli/bin/privmsg.js", import.meta.url));

test("bare invocation and help show package version and examples without reading stdin or creating a share", async () => {
  const { version } = JSON.parse(await readFile(new URL("../cli/package.json", import.meta.url), "utf8"));
  const setup = `
    process.stdin[Symbol.asyncIterator] = () => { throw new Error("Help must not read stdin"); };
    globalThis.fetch = () => { throw new Error("Help must not create a share"); };
  `;
  for (const args of [[], ["--help"], ["-h"], ["create", "--help"], ["--version"], ["-v"]]) {
    const result = spawnSync(process.execPath, [
      "--import", `data:text/javascript,${encodeURIComponent(setup)}`, cliPath, ...args
    ], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    if (args.includes("--version") || args.includes("-v")) {
      assert.equal(result.stdout, `${version}\n`);
    } else {
      assert.ok(result.stdout.startsWith(`privmsg ${version}\n\nUsage: privmsg`));
      assert.match(result.stdout, /Examples:/);
      assert.ok(result.stdout.includes('privmsg create "secret text"'));
      assert.ok(result.stdout.includes("| privmsg create"));
      assert.ok(result.stdout.includes("privmsg create --file ./report.pdf"));
    }
  }
});

test("rejects vulnerable Node releases before reading input or contacting a server", () => {
  for (const version of ["20.20.0", "22.22.2", "22.23.3", "23.11.0", "24.22.0", "25.0.0", "26.12.0"]) {
    const setup = `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });
      globalThis.fetch = () => { throw new Error("Network must not be reached"); };`;
    const result = spawnSync(process.execPath, [
      "--import", `data:text/javascript,${encodeURIComponent(setup)}`, cliPath, "create", "secret"
    ], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 1, `${version}: ${result.stderr}`);
    assert.match(result.stderr, /Upgrade Node\.js/);
    assert.equal(result.stdout, "");
  }
  for (const version of ["22.23.4", "22.24.0", "24.22.1", "24.23.0", "26.12.1", "26.13.0"]) {
    const setup = `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });`;
    const result = spawnSync(process.execPath, [
      "--import", `data:text/javascript,${encodeURIComponent(setup)}`, cliPath, "--help"
    ], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, `${version}: ${result.stderr}`);
    assert.match(result.stdout, /Usage: privmsg/);
  }
});

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

test("file-only and mixed shares keep names private and decrypt with the browser protocol", async () => {
  for (const message of [undefined, "Related documents"]) {
    const id = "test-message-id-0123456789";
    const serverKeyShare = Buffer.alloc(32, 7).toString("base64url");
    const files = [
      new File([new Uint8Array([0, 255, 128, 1])], "机密.bin"),
      new File(["private notes"], "notes.TXT"),
      new File([], "empty.pdf")
    ];
    let form;
    const result = await createShare({
      message,
      files,
      fetchImpl: async (url, init) => {
        if (new URL(url).pathname.endsWith("create-bootstrap")) {
          return Response.json({ id, serverKeyShare });
        }
        form = init.body;
        return Response.json({ ok: true, id }, { status: 201 });
      }
    });
    const metadata = JSON.parse(form.get("metadata"));
    const key = await deriveAccessKeyMaterial(
      base64UrlDecode(new URL(result.shareUrl).hash.slice(1)), base64UrlDecode(serverKeyShare), id
    );
    const payload = await decryptJsonValue(metadata.payload.ciphertext, metadata.payload.iv, key, id, "payload");
    assert.equal(payload.message, message ?? "");
    assert.equal(metadata.totalSize, files.reduce((sum, file) => sum + file.size, 0));
    assert.equal(payload.attachments[1].type, "text/plain");
    assert.equal(payload.attachments[2].type, "application/pdf");
    for (const [index, file] of files.entries()) {
      const part = form.get(`file-${index}`);
      assert.equal(part.name, `${index}.bin`);
      assert.equal(part.size, file.size + 16);
      assert.equal(metadata.attachments[index].encryptedSize, part.size);
      assert.equal(payload.attachments[index].name, file.name);
      assert.equal(payload.attachments[index].size, file.size);
      assert.ok(!form.get("metadata").includes(file.name));
      const decrypted = await decryptBytes(await part.arrayBuffer(), metadata.attachments[index].iv, key, id, `file:${index}`);
      assert.deepEqual(decrypted, new Uint8Array(await file.arrayBuffer()));
      await assert.rejects(decryptBytes(await part.arrayBuffer(), metadata.attachments[index].iv, key, id, `file:${index + 1}`));
    }
  }
});

test("rejects combined oversized attachments before reading files or contacting the server", async () => {
  assert.equal(MAX_TOTAL_SIZE_BYTES, WEB_MAX_TOTAL_SIZE_BYTES);
  const file = (size) => ({ name: "large.bin", size, arrayBuffer: () => assert.fail("Must not read oversized files") });
  await assert.rejects(createShare({
    files: [file(MAX_TOTAL_SIZE_BYTES), file(1)],
    fetchImpl: () => assert.fail("Must validate before making network requests")
  }), /50 MiB/);
  await assert.rejects(createShare({ files: [], fetchImpl: () => assert.fail("Empty shares must not be uploaded") }), /message or at least one file/);
});

test("CLI sends repeated files, supports explicit stdin, and rejects invalid paths before uploading", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "privmsg-files-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = join(dir, "机密 notes.txt");
  const second = join(dir, "empty.bin");
  await writeFile(first, "private notes");
  await writeFile(second, "");
  const mockFetch = `
    import { base64UrlDecode, decryptJsonValue, deriveAccessKeyMaterial } from ${JSON.stringify(new URL("../frontend/lib/privmsg.js", import.meta.url).href)};
    const id = 'test-message-id-0123456789';
    const serverKeyShare = 'A'.repeat(43);
    let metadata;
    const originalRandom = crypto.getRandomValues.bind(crypto);
    let localKey;
    crypto.getRandomValues = (array) => { originalRandom(array); if (array.length === 32) localKey = array.slice(); return array; };
    globalThis.fetch = async (url, init) => {
      if (new URL(url).pathname.endsWith('create-bootstrap')) return Response.json({id, serverKeyShare});
      metadata = JSON.parse(init.body.get('metadata'));
      const key = await deriveAccessKeyMaterial(localKey, base64UrlDecode(serverKeyShare), id);
      const payload = await decryptJsonValue(metadata.payload.ciphertext, metadata.payload.iv, key, id, 'payload');
      return Response.json({ok: true, message: payload.message, names: payload.attachments.map(file => file.name)});
    };
  `;
  const run = (args, input = "") => spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(mockFetch)}`, cliPath, "create", "--json", ...args
  ], { encoding: "utf8", input, timeout: 10000, env: { ...process.env, XDG_CONFIG_HOME: dir } });
  for (const [args, input, expected] of [
    [["--file", first, "--file", second], "ignored stdin", ""],
    [["Notes", "--file", first], "", "Notes"],
    [["-", "--file", first], "来自 stdin", "来自 stdin"],
    [[], "text only", "text only"]
  ]) {
    const result = run(args, input);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.message, expected);
    assert.equal(body.names.length, args.filter(arg => arg === "--file").length);
    if (body.names.length) assert.equal(body.names[0], "机密 notes.txt");
  }
  for (const [args, error] of [
    [["--file", dir], /Not a regular file/],
    [["--file", join(dir, "missing")], /ENOENT/],
    [["--file"], /requires a value/]
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
  }
  const large = join(dir, "oversized.bin");
  await writeFile(large, "");
  await truncate(large, MAX_TOTAL_SIZE_BYTES + 1);
  const oversized = run(["--file", large]);
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /50 MiB/);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  PASSWORD_PROTECTION_ALGORITHM,
  PASSWORD_PROTECTION_ITERATIONS,
  base64UrlDecode,
  base64UrlEncode,
  derivePasswordProof,
  generatePasswordSalt
} from "../frontend/lib/privmsg.js";
import worker from "../src/worker.js";

function createEnv() {
  const requests = [];

  return {
    env: {
      DB: {},
      BUCKET: {},
      ASSETS: {
        fetch(request) {
          requests.push(request);
          return new Response("ok", { status: 200 });
        }
      }
    },
    requests
  };
}

function createMessageEnv({
  id = "test-message-id-0123456789",
  attachmentCount = 0,
  maxReads = 2,
  readCount = 0,
  burned = 0,
  serverKeyShare = "A".repeat(43),
  encryptionMode = "standard",
  passwordProtection = null
} = {}) {
  const attachments = Array.from({ length: attachmentCount }, (_, index) => ({
    index,
    iv: `attachment-iv-${index}`,
    encryptedSize: 3
  }));
  const payloadObject = {
    version: 1,
    encryptionMode,
    payload: {
      iv: "payload-iv",
      ciphertext: "payload-ciphertext"
    },
    attachments,
    access: {
      serverKeyShare,
      ...(passwordProtection ? { passwordProtection } : {})
    }
  };
  const message = {
    id,
    attachmentCount,
    totalSize: 0,
    maxReads,
    readCount,
    createdAt: "2026-04-18T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    burned
  };
  const deletedKeys = [];

  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            this.args = args;
            return this;
          },
          async first() {
            if (!sql.includes("FROM messages")) {
              return null;
            }

            if (!message || this.args[0] !== message.id) {
              return null;
            }

            return { ...message };
          },
          async run() {
            if (sql.includes("read_count = read_count + 1")) {
              if (!message || this.args[0] !== message.id) {
                return { meta: { changes: 0 } };
              }

              if (message.burned === 1 || message.readCount >= message.maxReads) {
                return { meta: { changes: 0 } };
              }

              message.readCount += 1;
              if (message.readCount >= message.maxReads) {
                message.burned = 1;
              }

              return { meta: { changes: 1 } };
            }

            if (sql.includes("SET burned = 1")) {
              if (message && this.args[0] === message.id) {
                message.burned = 1;
              }

              return { meta: { changes: 1 } };
            }

            return { meta: { changes: 0 } };
          }
        };
      }
    },
    BUCKET: {
      async get(key) {
        if (key === `messages/${id}/payload.bin`) {
          return {
            async text() {
              return JSON.stringify(payloadObject);
            }
          };
        }

        const attachmentMatch = key.match(new RegExp(`^messages/${id}/files/(\\d+)\\.bin$`));
        if (attachmentMatch) {
          return {
            body: new Uint8Array([1, 2, 3])
          };
        }

        return null;
      },
      async delete(key) {
        deletedKeys.push(key);
      }
    },
    ASSETS: {
      fetch() {
        return new Response("ok", { status: 200 });
      }
    }
  };

  return {
    env,
    message,
    deletedKeys,
    serverKeyShare
  };
}

async function createPasswordProtection(id, password = "shared-secret") {
  const salt = generatePasswordSalt();
  return {
    algorithm: PASSWORD_PROTECTION_ALGORITHM,
    salt: base64UrlEncode(salt),
    iterations: PASSWORD_PROTECTION_ITERATIONS,
    verifier: await derivePasswordProof(password, salt, id, PASSWORD_PROTECTION_ITERATIONS)
  };
}

test("serves the root asset for message routes without requesting index.html directly", async () => {
  const { env, requests } = createEnv();

  const response = await worker.fetch(new Request("https://example.com/m/test-id"), env, {
    waitUntil() {}
  });

  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).pathname, "/");
});

test("serves the policy entry without requesting policy/index.html directly", async () => {
  const { env, requests } = createEnv();

  const response = await worker.fetch(new Request("https://example.com/policy"), env, {
    waitUntil() {}
  });

  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).pathname, "/policy/");
});

test("serves the enhanced-encryption bootstrap resource", async () => {
  const { env } = createEnv();

  const response = await worker.fetch(new Request("https://example.com/api/enhanced-encryption/bootstrap"), env, {
    waitUntil() {}
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");

  const body = await response.json();
  assert.equal(body.version, "x25519-bootstrap-v1");
  assert.equal(body.algorithm, "X25519-HKDF-AES-256-GCM");
  assert.equal(body.metadataField, "encryptionMode");
});

test("serves the create bootstrap resource with a message id and server key share", async () => {
  const { env } = createEnv();

  const response = await worker.fetch(new Request("https://example.com/api/create-bootstrap", { method: "POST" }), env, {
    waitUntil() {}
  });

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.match(body.id, /^[A-Za-z0-9_-]{20,64}$/);
  assert.match(body.serverKeyShare, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.bootstrap.version, "access-key-bootstrap-v1");
});

test("does not leak the server key share from the public message response", async () => {
  const { env, serverKeyShare } = createMessageEnv();

  const response = await worker.fetch(new Request("https://example.com/api/message/test-message-id-0123456789"), env, {
    waitUntil() {}
  });

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.access, undefined);
  assert.equal(body.serverKeyShare, undefined);
  assert.notEqual(body.payload.ciphertext, undefined);
  assert.notEqual(serverKeyShare, undefined);
});

test("issues the server key share and consumes a read atomically", async () => {
  const { env, message, deletedKeys, serverKeyShare } = createMessageEnv({ maxReads: 1 });

  const response = await worker.fetch(
    new Request("https://example.com/api/message/test-message-id-0123456789/access-key", { method: "POST" }),
    env,
    {
      waitUntil() {}
    }
  );

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.serverKeyShare, serverKeyShare);
  assert.equal(body.burned, true);
  assert.equal(body.remainingReads, 0);
  assert.equal(message.readCount, 1);
  assert.deepEqual(deletedKeys, ["messages/test-message-id-0123456789/payload.bin"]);
});

test("requires the access password before returning ciphertext or access keys", async () => {
  const id = "test-message-id-0123456789";
  const passwordProtection = await createPasswordProtection(id);
  const { env } = createMessageEnv({ id, attachmentCount: 1, passwordProtection });

  const messageResponse = await worker.fetch(new Request(`https://example.com/api/message/${id}`), env, {
    waitUntil() {}
  });
  assert.equal(messageResponse.status, 401);
  const messageBody = await messageResponse.json();
  assert.equal(messageBody.error, "password_required");
  assert.equal(messageBody.payload, undefined);
  assert.equal(messageBody.passwordProtection.salt, passwordProtection.salt);

  const accessKeyResponse = await worker.fetch(new Request(`https://example.com/api/message/${id}/access-key`, { method: "POST" }), env, {
    waitUntil() {}
  });
  assert.equal(accessKeyResponse.status, 401);
  const accessKeyBody = await accessKeyResponse.json();
  assert.equal(accessKeyBody.error, "password_required");
  assert.equal(accessKeyBody.serverKeyShare, undefined);

  const fileResponse = await worker.fetch(new Request(`https://example.com/api/message/${id}/file/0`), env, {
    waitUntil() {}
  });
  assert.equal(fileResponse.status, 401);
});

test("returns ciphertext after the correct access password proof is supplied", async () => {
  const id = "test-message-id-0123456789";
  const passwordProtection = await createPasswordProtection(id);
  const { env, serverKeyShare } = createMessageEnv({ id, passwordProtection });
  const passwordProof = await derivePasswordProof(
    "shared-secret",
    base64UrlDecode(passwordProtection.salt),
    id,
    PASSWORD_PROTECTION_ITERATIONS
  );

  const messageResponse = await worker.fetch(
    new Request(`https://example.com/api/message/${id}`, {
      headers: {
        "x-privmsg-password-proof": passwordProof
      }
    }),
    env,
    {
      waitUntil() {}
    }
  );
  assert.equal(messageResponse.status, 200);
  const messageBody = await messageResponse.json();
  assert.equal(messageBody.payload.ciphertext, "payload-ciphertext");

  const accessKeyResponse = await worker.fetch(
    new Request(`https://example.com/api/message/${id}/access-key`, {
      method: "POST",
      headers: {
        "x-privmsg-password-proof": passwordProof
      }
    }),
    env,
    {
      waitUntil() {}
    }
  );
  assert.equal(accessKeyResponse.status, 200);
  const accessKeyBody = await accessKeyResponse.json();
  assert.equal(accessKeyBody.serverKeyShare, serverKeyShare);
});

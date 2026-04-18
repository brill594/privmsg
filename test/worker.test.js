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
  passwordProtection = null,
  usageCounters = {},
  usageState = {},
  envVars = {}
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
    storedBytes: 32,
    maxReads,
    readCount,
    createdAt: "2026-04-18T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    burned,
    objectsDeleted: 0,
    storageProjectionMonth: "2026-04"
  };
  const deletedKeys = [];
  const counters = new Map(Object.entries(usageCounters));
  const states = new Map(Object.entries(usageState));

  function counterKey(scope, periodKey, metric) {
    return `${scope}:${periodKey}:${metric}`;
  }

  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            this.args = args;
            return this;
          },
          async all() {
            if (sql.includes("FROM usage_counters")) {
              const [dayScope, dayKey, monthScope, monthKey] = this.args;
              const results = [];

              for (const [key, value] of counters.entries()) {
                const [scope, periodKey, metric] = key.split(":");
                if ((scope === dayScope && periodKey === dayKey) || (scope === monthScope && periodKey === monthKey)) {
                  results.push({ scope, periodKey, metric, value });
                }
              }

              return { results, meta: { rows_read: results.length, rows_written: 0, size_after: 1024 } };
            }

            if (sql.includes("FROM usage_state")) {
              const [firstKey, secondKey] = this.args;
              const results = [];

              for (const key of [firstKey, secondKey]) {
                if (states.has(key)) {
                  results.push({ key, value: states.get(key) });
                }
              }

              return { results, meta: { rows_read: results.length, rows_written: 0, size_after: 1024 } };
            }

            if (sql.includes("FROM messages")) {
              if (!message || this.args[0] !== message.id) {
                return { results: [], meta: { rows_read: 0, rows_written: 0, size_after: 1024 } };
              }

              return { results: [{ ...message }], meta: { rows_read: 1, rows_written: 0, size_after: 1024 } };
            }

            return { results: [], meta: { rows_read: 0, rows_written: 0, size_after: 1024 } };
          },
          async run() {
            if (sql.includes("INSERT INTO usage_counters")) {
              const [scope, periodKey, metric, value] = this.args;
              const key = counterKey(scope, periodKey, metric);
              counters.set(key, Number(counters.get(key) || 0) + Number(value || 0));
              return { meta: { changes: 1, rows_read: 0, rows_written: 1, size_after: 1024 } };
            }

            if (sql.includes("INSERT INTO usage_state")) {
              const [key, value] = this.args;
              if (sql.includes("value = MAX(0, usage_state.value + excluded.value)")) {
                states.set(key, Math.max(0, Number(states.get(key) || 0) + Number(value || 0)));
              } else {
                states.set(key, Number(value || 0));
              }

              return { meta: { changes: 1, rows_read: 0, rows_written: 1, size_after: 1024 } };
            }

            if (sql.includes("read_count = read_count + 1")) {
              if (!message || this.args[0] !== message.id) {
                return { meta: { changes: 0, rows_read: 0, rows_written: 0, size_after: 1024 } };
              }

              if (message.burned === 1 || message.readCount >= message.maxReads) {
                return { meta: { changes: 0, rows_read: 0, rows_written: 0, size_after: 1024 } };
              }

              message.readCount += 1;
              if (message.readCount >= message.maxReads) {
                message.burned = 1;
              }

              return { meta: { changes: 1, rows_read: 1, rows_written: 1, size_after: 1024 } };
            }

            if (sql.includes("SET burned = 1")) {
              if (message && this.args[0] === message.id) {
                message.burned = 1;
              }

              return { meta: { changes: 1, rows_read: 0, rows_written: 1, size_after: 1024 } };
            }

            if (sql.includes("SET objects_deleted = 1")) {
              if (message && this.args[0] === message.id && message.objectsDeleted === 0) {
                message.objectsDeleted = 1;
                return { meta: { changes: 1, rows_read: 0, rows_written: 1, size_after: 1024 } };
              }

              return { meta: { changes: 0, rows_read: 0, rows_written: 0, size_after: 1024 } };
            }

            if (sql.includes("DELETE FROM messages WHERE id = ?1")) {
              return { meta: { changes: 1, rows_read: 0, rows_written: 1, size_after: 1024 } };
            }

            if (sql.includes("SET storage_projection_month = ?2")) {
              if (message && this.args[0] === message.id && message.storageProjectionMonth !== this.args[1]) {
                message.storageProjectionMonth = this.args[1];
                return { meta: { changes: 1, rows_read: 0, rows_written: 1, size_after: 1024 } };
              }

              return { meta: { changes: 0, rows_read: 0, rows_written: 0, size_after: 1024 } };
            }

            return { meta: { changes: 0, rows_read: 0, rows_written: 0, size_after: 1024 } };
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
    },
    ...envVars
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

test("rejects requests that would exceed the configured D1 daily read limit", async () => {
  const dayKey = new Date().toISOString().slice(0, 10);
  const { env } = createMessageEnv({
    usageCounters: {
      [`day:${dayKey}:d1_rows_read`]: 1
    },
    envVars: {
      USAGE_LIMIT_D1_ROWS_READ_DAILY: "1"
    }
  });

  const response = await worker.fetch(new Request("https://example.com/api/message/test-message-id-0123456789"), env, {
    waitUntil() {}
  });

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, "usage_limit_exceeded");
  assert.equal(body.breaches[0].metric, "d1_rows_read_daily");
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

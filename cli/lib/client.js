const DEFAULT_BASE_URL = "https://privmsg.cc";
const DEFAULT_EXPIRES_IN_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_READS = 1;
const MIN_EXPIRES_IN_SECONDS = 60 * 60;
const MAX_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;
const MAX_MESSAGE_CHARACTERS = 100000;
const MIN_MAX_READS = 1;
const MAX_MAX_READS = 20;

const textEncoder = new TextEncoder();

export async function createShare({
  message,
  baseUrl,
  server = DEFAULT_BASE_URL,
  expiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS,
  maxReads = DEFAULT_MAX_READS,
  fetchImpl = fetch
}) {
  validateOptions({ message, expiresInSeconds, maxReads });

  const serverUrl = normalizeBaseUrl(baseUrl ?? server);
  const bootstrap = await requestJson(fetchImpl, new URL("api/create-bootstrap", serverUrl), {
    method: "POST",
    headers: {
      Accept: "application/json"
    }
  });

  if (!isMessageId(bootstrap.id) || !isKeyShare(bootstrap.serverKeyShare)) {
    throw new Error("Server returned an invalid creation bootstrap");
  }

  const localKeyShareBytes = crypto.getRandomValues(new Uint8Array(32));
  const serverKeyShareBytes = base64UrlDecode(bootstrap.serverKeyShare);
  const accessKeyMaterial = await deriveAccessKeyMaterial(localKeyShareBytes, serverKeyShareBytes, bootstrap.id);
  const payload = await encryptJsonValue(
    {
      version: 1,
      message,
      attachments: []
    },
    accessKeyMaterial,
    bootstrap.id,
    "payload"
  );

  const formData = new FormData();
  formData.append(
    "metadata",
    JSON.stringify({
      id: bootstrap.id,
      serverKeyShare: bootstrap.serverKeyShare,
      encryptionMode: "standard",
      totalSize: 0,
      expiresInSeconds,
      maxReads,
      payload,
      attachments: []
    })
  );

  const result = await requestJson(fetchImpl, new URL("api/create", serverUrl), {
    method: "POST",
    body: formData
  });
  const localKeyShare = base64UrlEncode(localKeyShareBytes);

  return {
    ...result,
    shareUrl: new URL(`m/${bootstrap.id}#${localKeyShare}`, serverUrl).toString()
  };
}

function validateOptions({ message, expiresInSeconds, maxReads }) {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new Error("Message must not be empty");
  }

  if (Array.from(message).length > MAX_MESSAGE_CHARACTERS) {
    throw new Error(`Message must not exceed ${MAX_MESSAGE_CHARACTERS} characters`);
  }

  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < MIN_EXPIRES_IN_SECONDS ||
    expiresInSeconds > MAX_EXPIRES_IN_SECONDS
  ) {
    throw new Error(`--expires-in must be an integer between ${MIN_EXPIRES_IN_SECONDS} and ${MAX_EXPIRES_IN_SECONDS}`);
  }

  if (!Number.isInteger(maxReads) || maxReads < MIN_MAX_READS || maxReads > MAX_MAX_READS) {
    throw new Error(`--max-reads must be an integer between ${MIN_MAX_READS} and ${MAX_MAX_READS}`);
  }
}

export function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("--base-url must use HTTPS unless it points to localhost");
  }
  return new URL(`${url.origin}${url.pathname.replace(/\/+$/, "")}/`);
}

async function requestJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, init);
  const body = await safeReadJson(response);

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const message = body.message || `Request failed with HTTP ${response.status}`;
    throw new Error(retryAfter ? `${message}. Retry after ${retryAfter} seconds.` : message);
  }

  return body;
}

async function safeReadJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function deriveAccessKeyMaterial(localKeyShareBytes, serverKeyShareBytes, messageId) {
  const combinedKeyMaterial = new Uint8Array(localKeyShareBytes.byteLength + serverKeyShareBytes.byteLength);
  combinedKeyMaterial.set(localKeyShareBytes, 0);
  combinedKeyMaterial.set(serverKeyShareBytes, localKeyShareBytes.byteLength);

  const hkdfKey = await crypto.subtle.importKey("raw", combinedKeyMaterial, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: textEncoder.encode(messageId),
        info: textEncoder.encode("privmsg:access-key:v1")
      },
      hkdfKey,
      256
    )
  );
}

async function encryptJsonValue(value, keyBytes, messageId, purpose) {
  const hkdfKey = await crypto.subtle.importKey("raw", keyBytes, "HKDF", false, ["deriveKey"]);
  const encryptionKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: textEncoder.encode(messageId),
      info: textEncoder.encode(`privmsg:${purpose}:v1`)
    },
    hkdfKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv
    },
    encryptionKey,
    textEncoder.encode(JSON.stringify(value))
  );

  return {
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(ciphertext)
  };
}

function isMessageId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(value);
}

function isKeyShare(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(value) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

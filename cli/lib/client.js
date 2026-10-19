export const MAX_TOTAL_SIZE_BYTES = 50 * 1024 * 1024;

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
  message = "",
  files = [],
  baseUrl,
  server = DEFAULT_BASE_URL,
  expiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS,
  maxReads = DEFAULT_MAX_READS,
  fetchImpl = fetch
}) {
  validateOptions({ message, files, expiresInSeconds, maxReads });

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
  const attachments = [];
  for (const [index, file] of files.entries()) {
    const encrypted = await encryptBytes(await file.arrayBuffer(), accessKeyMaterial, bootstrap.id, `file:${index}`);
    attachments.push({
      index,
      iv: encrypted.iv,
      encryptedBlob: new Blob([encrypted.ciphertext], { type: "application/octet-stream" }),
      meta: { index, name: file.name, type: file.type || inferMimeType(file.name), size: file.size }
    });
  }
  const payload = await encryptJsonValue(
    { version: 1, message, attachments: attachments.map(({ meta }) => meta) },
    accessKeyMaterial,
    bootstrap.id,
    "payload"
  );
  const metadata = {
    id: bootstrap.id,
    serverKeyShare: bootstrap.serverKeyShare,
    encryptionMode: "standard",
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    expiresInSeconds,
    maxReads,
    payload,
    attachments: attachments.map(({ index, iv, encryptedBlob }) => ({ index, iv, encryptedSize: encryptedBlob.size }))
  };
  const formData = new FormData();
  formData.append("metadata", JSON.stringify(metadata));
  for (const { index, encryptedBlob } of attachments) {
    formData.append(`file-${index}`, encryptedBlob, `${index}.bin`);
  }
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

function validateOptions({ message, files, expiresInSeconds, maxReads }) {
  if (!Array.isArray(files) || files.some((file) => (
    !file ||
    typeof file.name !== "string" ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    typeof file.arrayBuffer !== "function"
  ))) {
    throw new Error("Files must have a name, size, and arrayBuffer() method");
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_SIZE_BYTES) {
    throw new Error("Total attachment size must not exceed 50 MiB");
  }
  if (typeof message !== "string" || (message.trim().length === 0 && files.length === 0)) {
    throw new Error("Provide a message or at least one file");
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
  const encrypted = await encryptBytes(textEncoder.encode(JSON.stringify(value)), keyBytes, messageId, purpose);
  return { iv: encrypted.iv, ciphertext: base64UrlEncode(encrypted.ciphertext) };
}

async function encryptBytes(value, keyBytes, messageId, purpose) {
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
    value
  );

  return {
    iv: base64UrlEncode(iv),
    ciphertext
  };
}

function inferMimeType(filename) {
  const extension = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";

  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "txt":
      return "text/plain";
    case "pdf":
      return "application/pdf";
    case "pk8":
      return "application/pkcs8";
    default:
      return "application/octet-stream";
  }
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

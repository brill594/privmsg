import {
  DEFAULT_READ_LIMIT,
  ENCRYPTION_MODE_ENHANCED,
  ENCRYPTION_MODE_STANDARD,
  MAX_MESSAGE_CHARACTERS,
  MAX_READ_LIMIT,
  MAX_TOTAL_SIZE_BYTES,
  clampReadLimit,
  isAllowedAttachment
} from "../../src/shared.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const X25519_ALGORITHM = "X25519";
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_PROTECTION_ITERATIONS = 250000;
const PASSWORD_PROTECTION_ALGORITHM = "PBKDF2-SHA-256";

export {
  DEFAULT_READ_LIMIT,
  ENCRYPTION_MODE_ENHANCED,
  ENCRYPTION_MODE_STANDARD,
  MAX_MESSAGE_CHARACTERS,
  MAX_READ_LIMIT,
  MAX_TOTAL_SIZE_BYTES,
  clampReadLimit,
  PASSWORD_PROTECTION_ALGORITHM,
  PASSWORD_PROTECTION_ITERATIONS
};

export function validateDraft(message, files, strings = {}) {
  if (!message.trim() && files.length === 0) {
    return strings.emptyDraft || "至少填写文本或选择一个附件。";
  }

  if (countMessageCharacters(message) > MAX_MESSAGE_CHARACTERS) {
    return strings.exceedsMessageLength
      ? strings.exceedsMessageLength(MAX_MESSAGE_CHARACTERS)
      : `文本长度不能超过 ${MAX_MESSAGE_CHARACTERS} 字。`;
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > MAX_TOTAL_SIZE_BYTES) {
    return strings.exceedsSize || "附件总大小不能超过 50MB。";
  }

  for (const file of files) {
    if (!isAllowedAttachment(file)) {
      return strings.unsupportedType ? strings.unsupportedType(file.name) : `不支持的附件类型: ${file.name}`;
    }
  }

  return "";
}

export function countMessageCharacters(message) {
  return Array.from(String(message || "")).length;
}

export function clampMessageCharacters(message, limit = MAX_MESSAGE_CHARACTERS) {
  return Array.from(String(message || "")).slice(0, limit).join("");
}

export async function encryptPayload(payloadObject, masterKeyBytes, messageId) {
  return encryptJsonValue(payloadObject, masterKeyBytes, messageId, "payload");
}

export async function encryptAttachment(file, index, masterKeyBytes, messageId) {
  const ciphertext = await encryptBytes(await file.arrayBuffer(), masterKeyBytes, messageId, `file:${index}`);

  return {
    index,
    iv: ciphertext.iv,
    encryptedBlob: new Blob([ciphertext.ciphertext], {
      type: "application/octet-stream"
    }),
    meta: {
      index,
      name: file.name,
      type: file.type || inferMimeType(file.name),
      size: file.size
    }
  };
}

export async function decryptToString(ciphertextBase64Url, ivBase64Url, key) {
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlDecode(ivBase64Url)
    },
    key,
    base64UrlDecode(ciphertextBase64Url)
  );

  return textDecoder.decode(decrypted);
}

export async function encryptBytes(plaintext, keyBytes, messageId, purpose) {
  const encryptionKey = await deriveAesKey(keyBytes, messageId, purpose, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv
    },
    encryptionKey,
    plaintext
  );

  return {
    iv: base64UrlEncode(iv),
    ciphertext: new Uint8Array(ciphertext)
  };
}

export async function decryptBytes(ciphertext, ivBase64Url, keyBytes, messageId, purpose) {
  const decryptionKey = await deriveAesKey(keyBytes, messageId, purpose, ["decrypt"]);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlDecode(ivBase64Url)
      },
      decryptionKey,
      ciphertext
    )
  );
}

export async function encryptJsonValue(value, keyBytes, messageId, purpose) {
  const ciphertext = await encryptBytes(textEncoder.encode(JSON.stringify(value)), keyBytes, messageId, purpose);
  return {
    iv: ciphertext.iv,
    ciphertext: base64UrlEncode(ciphertext.ciphertext)
  };
}

export async function decryptJsonValue(ciphertextBase64Url, ivBase64Url, keyBytes, messageId, purpose) {
  const plaintext = await decryptBytes(base64UrlDecode(ciphertextBase64Url), ivBase64Url, keyBytes, messageId, purpose);
  return JSON.parse(textDecoder.decode(plaintext));
}

export async function generateX25519KeyPair() {
  return crypto.subtle.generateKey({ name: X25519_ALGORITHM }, true, ["deriveBits"]);
}

export async function exportX25519PublicKey(publicKey) {
  return base64UrlEncode(await crypto.subtle.exportKey("raw", publicKey));
}

export async function exportX25519PrivateKey(privateKey) {
  return new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
}

export async function importX25519PublicKey(value) {
  const keyBytes = base64UrlDecode(normalizeKeyText(value));
  if (keyBytes.byteLength !== 32) {
    throw new Error("Invalid X25519 public key");
  }

  return crypto.subtle.importKey("raw", keyBytes, X25519_ALGORITHM, false, []);
}

export async function importX25519PrivateKey(data) {
  return crypto.subtle.importKey("pkcs8", data, X25519_ALGORITHM, false, ["deriveBits"]);
}

export async function deriveX25519SharedSecret(privateKey, publicKey) {
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: X25519_ALGORITHM,
        public: publicKey
      },
      privateKey,
      256
    )
  );
}

export function normalizeKeyText(value) {
  return String(value || "").replace(/\s+/g, "");
}

export async function deriveAesKey(masterKeyBytes, messageId, purpose, usages) {
  const hkdfKey = await crypto.subtle.importKey("raw", masterKeyBytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
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
    usages
  );
}

export async function deriveAccessKeyMaterial(localKeyShareBytes, serverKeyShareBytes, messageId) {
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

export function generatePasswordSalt() {
  return crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
}

export async function derivePasswordProof(password, saltBytes, messageId, iterations = PASSWORD_PROTECTION_ITERATIONS) {
  const normalizedPassword = String(password ?? "");
  if (!normalizedPassword.trim()) {
    throw new Error("Password is required");
  }

  const normalizedSalt = saltBytes instanceof Uint8Array ? saltBytes : new Uint8Array(saltBytes);
  if (!normalizedSalt.byteLength) {
    throw new Error("Password salt is required");
  }

  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("Invalid password derivation iterations");
  }

  const passwordKey = await crypto.subtle.importKey("raw", textEncoder.encode(normalizedPassword), "PBKDF2", false, [
    "deriveBits"
  ]);
  const contextualSalt = new Uint8Array(textEncoder.encode(`privmsg:password-proof:v1:${messageId}:`).byteLength + normalizedSalt.byteLength);
  contextualSalt.set(textEncoder.encode(`privmsg:password-proof:v1:${messageId}:`), 0);
  contextualSalt.set(normalizedSalt, contextualSalt.byteLength - normalizedSalt.byteLength);

  return base64UrlEncode(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: contextualSalt,
          iterations
        },
        passwordKey,
        256
      )
    )
  );
}

export function generateOpaqueId() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

export function inferMimeType(filename) {
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

export function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function readMessageIdFromPath(pathname = window.location.pathname) {
  const segments = pathname.split("/").filter(Boolean);
  return segments.at(-1) || "";
}

export async function safeReadJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function createPreviewDocument(innerHtml) {
  return `<!doctype html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8">
      <style>
        :root { color-scheme: light; }
        body {
          margin: 0;
          min-height: 100vh;
          display: grid;
          place-items: center;
          background:
            radial-gradient(circle at top left, rgba(176, 72, 117, 0.20), transparent 18rem),
            linear-gradient(180deg, #0e0b12 0%, #151019 100%);
          color: #f3dbe7;
          font: 16px/1.6 "Avenir Next", "Helvetica Neue", sans-serif;
        }
        img, video, iframe {
          width: min(100%, 100vw);
          max-height: 100vh;
          border: 0;
          background: #0f0c13;
        }
        pre {
          margin: 0;
          width: 100%;
          min-height: 100vh;
          padding: 24px;
          white-space: pre-wrap;
          word-break: break-word;
          box-sizing: border-box;
          font: 14px/1.6 "SF Mono", Menlo, monospace;
        }
      </style>
    </head>
    <body>${innerHtml}</body>
  </html>`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function base64UrlEncode(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(value) {
  const padded = `${value}`.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

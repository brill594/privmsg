import {
  DEFAULT_READ_LIMIT,
  ENCRYPTION_MODE_ENHANCED,
  ENCRYPTION_MODE_STANDARD,
  MAX_PAYLOAD_BYTES,
  MAX_READ_LIMIT,
  MAX_TOTAL_SIZE_BYTES,
  clampTtlSeconds,
  clampReadLimit,
  approximateBytesFromBase64Url,
  isValidMessageId,
  normalizeEncryptionMode
} from "./shared.js";

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Type": "application/json; charset=utf-8"
};

const BINARY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Disposition": "attachment",
  "X-Content-Type-Options": "nosniff"
};
const PASSWORD_PROOF_HEADER = "x-privmsg-password-proof";

const ENHANCED_BOOTSTRAP = {
  version: "x25519-bootstrap-v1",
  algorithm: "X25519-HKDF-AES-256-GCM",
  publicKeyEncoding: "base64url-raw-32",
  privateKeyEncoding: "pkcs8",
  metadataField: "encryptionMode",
  note: "Generate key pairs locally. Never upload private keys."
};

const CREATE_BOOTSTRAP = {
  version: "access-key-bootstrap-v1",
  keyShareEncoding: "base64url-raw-32",
  note: "Combine the local key share with the server-issued key share before deriving the outer encryption key."
};

export default {
  async fetch(request, env, ctx) {
    try {
      assertBindings(env);

      const url = new URL(request.url);

      if (url.pathname === "/api/create") {
        return await handleCreate(request, env);
      }

      if (url.pathname === "/api/create-bootstrap") {
        return handleCreateBootstrap(request);
      }

      if (url.pathname === "/api/enhanced-encryption/bootstrap") {
        return handleEnhancedBootstrap();
      }

      const messageMatch = url.pathname.match(/^\/api\/message\/([A-Za-z0-9_-]{20,64})$/);
      if (messageMatch) {
        return await handleGetMessage(request, messageMatch[1], env, ctx);
      }

      const fileMatch = url.pathname.match(/^\/api\/message\/([A-Za-z0-9_-]{20,64})\/file\/(\d+)$/);
      if (fileMatch) {
        return await handleGetFile(request, fileMatch[1], Number(fileMatch[2]), env, ctx);
      }

      const accessKeyMatch = url.pathname.match(/^\/api\/message\/([A-Za-z0-9_-]{20,64})\/access-key$/);
      if (accessKeyMatch) {
        return await handleIssueAccessKey(request, accessKeyMatch[1], env);
      }

      if (url.pathname === "/" || url.pathname.startsWith("/m/")) {
        return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
      }

      if (url.pathname === "/policy" || url.pathname === "/policy/") {
        return env.ASSETS.fetch(new Request(new URL("/policy/", request.url), request));
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json(
        {
          error: "internal_error",
          message: "Internal server error"
        },
        500
      );
    }
  }
};

function assertBindings(env) {
  if (!env.DB || !env.BUCKET || !env.ASSETS) {
    throw new Error("Missing required Cloudflare bindings");
  }
}

async function handleCreate(request, env) {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "invalid_request", message: "Expected multipart/form-data" }, 400);
  }

  const formData = await request.formData();
  const rawMetadata = formData.get("metadata");

  if (typeof rawMetadata !== "string") {
    return json({ error: "invalid_request", message: "Missing metadata field" }, 400);
  }

  let metadata;
  try {
    metadata = JSON.parse(rawMetadata);
  } catch {
    return json({ error: "invalid_request", message: "Malformed metadata JSON" }, 400);
  }

  const validation = validateCreateMetadata(metadata);
  if (!validation.ok) {
    return json({ error: "invalid_request", message: validation.message }, validation.status);
  }

  const { id, attachments, encryptionMode, totalSize, payload, expiresAt, maxReads, serverKeyShare, passwordProtection } =
    validation.value;
  const attachmentBuffers = [];
  let totalEncryptedSize = 0;

  for (const attachment of attachments) {
    const formPart = formData.get(`file-${attachment.index}`);
    if (
      !formPart ||
      typeof formPart !== "object" ||
      typeof formPart.arrayBuffer !== "function" ||
      !Number.isInteger(formPart.size)
    ) {
      return json(
        {
          error: "invalid_request",
          message: `Missing encrypted attachment part for index ${attachment.index}`
        },
        400
      );
    }

    if (formPart.size !== attachment.encryptedSize) {
      return json(
        {
          error: "invalid_request",
          message: `Encrypted attachment size mismatch for index ${attachment.index}`
        },
        400
      );
    }

    totalEncryptedSize += formPart.size;
    attachmentBuffers.push({
      index: attachment.index,
      data: await formPart.arrayBuffer()
    });
  }

  if (totalSize > MAX_TOTAL_SIZE_BYTES) {
    return json({ error: "payload_too_large", message: "Attachment payload exceeds 50MB" }, 413);
  }

  const allowableEncryptedSize = MAX_TOTAL_SIZE_BYTES + attachments.length * 64 + MAX_PAYLOAD_BYTES;
  if (totalEncryptedSize > allowableEncryptedSize) {
    return json(
      {
        error: "payload_too_large",
        message: "Encrypted attachment payload exceeds service limit"
      },
      413
    );
  }

  const nowIso = new Date().toISOString();
  const messageRecord = {
    id,
    attachmentCount: attachments.length,
    totalSize,
    maxReads,
    readCount: 0,
    createdAt: nowIso,
    expiresAt
  };

  try {
    await env.DB.prepare(
      `
        INSERT INTO messages (id, attachment_count, total_size, max_reads, read_count, created_at, expires_at, burned)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
      `
    )
      .bind(
        messageRecord.id,
        messageRecord.attachmentCount,
        messageRecord.totalSize,
        messageRecord.maxReads,
        messageRecord.readCount,
        messageRecord.createdAt,
        messageRecord.expiresAt
      )
      .run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      return json({ error: "conflict", message: "Message id already exists" }, 409);
    }
    throw error;
  }

  const access = {
    serverKeyShare
  };
  if (passwordProtection) {
    access.passwordProtection = passwordProtection;
  }

  const payloadObject = {
    version: 1,
    encryptionMode,
    payload,
    attachments: attachments.map(({ index, iv, encryptedSize }) => ({
      index,
      iv,
      encryptedSize
    })),
    access
  };

  try {
    await env.BUCKET.put(messagePayloadKey(id), JSON.stringify(payloadObject), {
      httpMetadata: {
        contentType: "application/json"
      }
    });

    for (const attachment of attachmentBuffers) {
      await env.BUCKET.put(messageAttachmentKey(id, attachment.index), attachment.data, {
        httpMetadata: {
          contentType: "application/octet-stream"
        }
      });
    }
  } catch (error) {
    await env.DB.prepare("DELETE FROM messages WHERE id = ?1").bind(id).run();
    await cleanupMessageObjects(env, id, attachments.length);
    throw error;
  }

  return json(
    {
      ok: true,
      id,
      encryptionMode,
      expiresAt,
      attachmentCount: attachments.length,
      totalSize,
      maxReads,
      remainingReads: maxReads
    },
    201
  );
}

function handleCreateBootstrap(request) {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  return json({
    id: generateOpaqueId(),
    bootstrap: CREATE_BOOTSTRAP,
    serverKeyShare: generateKeyShare()
  });
}

async function handleGetMessage(request, id, env, ctx) {
  if (!isValidMessageId(id)) {
    return json({ error: "invalid_request", message: "Invalid message id" }, 400);
  }

  const message = await getMessageRecord(env, id);
  if (!message) {
    return json({ error: "not_found", message: "Message not found" }, 404);
  }

  if (isBurnedOrExpired(message)) {
    ctx.waitUntil(markBurnedAndCleanup(env, message));
    return json({ error: "gone", message: "Message has already been burned" }, 410);
  }

  const payload = await getStoredPayload(env, id);
  if (!payload) {
    ctx.waitUntil(markBurnedAndCleanup(env, message));
    return json({ error: "gone", message: "Encrypted payload is unavailable" }, 410);
  }

  const passwordError = validatePasswordGate(request, payload?.access?.passwordProtection);
  if (passwordError) {
    return passwordError;
  }

  const { access: _access, ...publicPayload } = payload;
  return json({
    id: message.id,
    encryptionMode: normalizeEncryptionMode(payload.encryptionMode),
    attachmentCount: message.attachmentCount,
    totalSize: message.totalSize,
    maxReads: message.maxReads,
    readCount: message.readCount,
    remainingReads: Math.max(0, message.maxReads - message.readCount),
    createdAt: message.createdAt,
    expiresAt: message.expiresAt,
    ...publicPayload
  });
}

function handleEnhancedBootstrap() {
  const body = JSON.stringify(ENHANCED_BOOTSTRAP);
  const headers = new Headers(JSON_HEADERS);
  headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
  return new Response(body, {
    status: 200,
    headers
  });
}

async function handleGetFile(request, id, index, env, ctx) {
  if (!isValidMessageId(id) || !Number.isInteger(index) || index < 0) {
    return json({ error: "invalid_request", message: "Invalid attachment request" }, 400);
  }

  const message = await getMessageRecord(env, id);
  if (!message) {
    return json({ error: "not_found", message: "Message not found" }, 404);
  }

  if (isBurnedOrExpired(message)) {
    ctx.waitUntil(markBurnedAndCleanup(env, message));
    return json({ error: "gone", message: "Message has already been burned" }, 410);
  }

  const payload = await getStoredPayload(env, id);
  if (!payload) {
    ctx.waitUntil(markBurnedAndCleanup(env, message));
    return json({ error: "gone", message: "Encrypted payload is unavailable" }, 410);
  }

  const passwordError = validatePasswordGate(request, payload?.access?.passwordProtection);
  if (passwordError) {
    return passwordError;
  }

  if (index >= message.attachmentCount) {
    return json({ error: "not_found", message: "Attachment not found" }, 404);
  }

  const attachment = await env.BUCKET.get(messageAttachmentKey(id, index));
  if (!attachment) {
    return json({ error: "not_found", message: "Attachment not found" }, 404);
  }

  const headers = new Headers(BINARY_HEADERS);
  headers.set("Content-Type", "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename="${id}-${index}.bin"`);

  return new Response(attachment.body, {
    status: 200,
    headers
  });
}

async function handleIssueAccessKey(request, id, env) {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  if (!isValidMessageId(id)) {
    return json({ error: "invalid_request", message: "Invalid message id" }, 400);
  }

  const message = await getMessageRecord(env, id);
  if (!message) {
    return json({ error: "not_found", message: "Message not found" }, 404);
  }

  if (isConsumed(message) || isExpired(message)) {
    await markBurnedAndCleanup(env, message);
    return json({ error: "gone", message: "Message has already been burned" }, 410);
  }

  const payload = await getStoredPayload(env, id);
  if (!payload) {
    await markBurnedAndCleanup(env, message);
    return json({ error: "gone", message: "Encrypted payload is unavailable" }, 410);
  }

  const passwordError = validatePasswordGate(request, payload?.access?.passwordProtection);
  if (passwordError) {
    return passwordError;
  }

  const serverKeyShare = payload?.access?.serverKeyShare;
  if (!isValidKeyShare(serverKeyShare)) {
    await markBurnedAndCleanup(env, message);
    return json({ error: "gone", message: "Message access key is unavailable" }, 410);
  }

  const updateResult = await env.DB.prepare(
    `
      UPDATE messages
      SET
        read_count = read_count + 1,
        burned = CASE WHEN read_count + 1 >= max_reads THEN 1 ELSE 0 END
      WHERE
        id = ?1
        AND burned = 0
        AND expires_at > ?2
        AND read_count < max_reads
    `
  )
    .bind(id, new Date().toISOString())
    .run();

  if ((updateResult.meta?.changes || 0) === 0) {
    const latestMessage = await getMessageRecord(env, id);
    if (!latestMessage) {
      return json({ error: "not_found", message: "Message not found" }, 404);
    }

    if (isConsumed(latestMessage) || isExpired(latestMessage)) {
      await markBurnedAndCleanup(env, latestMessage);
      return json({ error: "gone", message: "Message has already been burned" }, 410);
    }
  }

  const updatedMessage = await getMessageRecord(env, id);
  if (!updatedMessage) {
    return json({ error: "not_found", message: "Message not found" }, 404);
  }

  const shouldBurn = isConsumed(updatedMessage);
  if (shouldBurn) {
    await cleanupMessageObjects(env, id, updatedMessage.attachmentCount);
  }

  return json({
    ok: true,
    burned: shouldBurn,
    maxReads: updatedMessage.maxReads,
    readCount: updatedMessage.readCount,
    remainingReads: Math.max(0, updatedMessage.maxReads - updatedMessage.readCount),
    serverKeyShare
  });
}

async function getMessageRecord(env, id) {
  const row = await env.DB.prepare(
    `
      SELECT
        id,
        attachment_count AS attachmentCount,
        total_size AS totalSize,
        max_reads AS maxReads,
        read_count AS readCount,
        created_at AS createdAt,
        expires_at AS expiresAt,
        burned
      FROM messages
      WHERE id = ?1
      LIMIT 1
    `
  )
    .bind(id)
    .first();

  return row || null;
}

async function getStoredPayload(env, id) {
  const payloadObject = await env.BUCKET.get(messagePayloadKey(id));
  if (!payloadObject) {
    return null;
  }

  return JSON.parse(await payloadObject.text());
}

function validateCreateMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return invalid("Metadata must be an object");
  }

  const id = metadata.id;
  if (!isValidMessageId(id)) {
    return invalid("Invalid message id");
  }

  const payload = metadata.payload;
  if (!payload || typeof payload !== "object") {
    return invalid("Missing encrypted payload");
  }

  if (typeof payload.iv !== "string" || typeof payload.ciphertext !== "string") {
    return invalid("Encrypted payload must include iv and ciphertext");
  }

  if (approximateBytesFromBase64Url(payload.ciphertext) > MAX_PAYLOAD_BYTES) {
    return invalid("Encrypted payload exceeds size limit", 413);
  }

  const encryptionMode = normalizeEncryptionMode(metadata.encryptionMode);
  if (metadata.encryptionMode && encryptionMode !== metadata.encryptionMode) {
    return invalid("Invalid encryption mode");
  }

  const serverKeyShare = metadata.serverKeyShare;
  if (!isValidKeyShare(serverKeyShare)) {
    return invalid("Invalid server key share");
  }

  const passwordProtectionValidation = validatePasswordProtection(metadata.passwordProtection);
  if (!passwordProtectionValidation.ok) {
    return invalid(passwordProtectionValidation.message);
  }

  const rawAttachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
  const attachments = [];

  for (let index = 0; index < rawAttachments.length; index += 1) {
    const attachment = rawAttachments[index];

    if (!attachment || typeof attachment !== "object") {
      return invalid(`Invalid attachment envelope at index ${index}`);
    }

    if (attachment.index !== index) {
      return invalid(`Attachment indices must be contiguous from zero`);
    }

    if (typeof attachment.iv !== "string" || !attachment.iv) {
      return invalid(`Missing iv for attachment ${index}`);
    }

    const encryptedSize = Number(attachment.encryptedSize);
    if (!Number.isInteger(encryptedSize) || encryptedSize <= 0) {
      return invalid(`Invalid encrypted size for attachment ${index}`);
    }

    attachments.push({
      index,
      iv: attachment.iv,
      encryptedSize
    });
  }

  const totalSize = Number(metadata.totalSize);
  if (!Number.isInteger(totalSize) || totalSize < 0) {
    return invalid("Invalid attachment total size");
  }

  const ttlSeconds = clampTtlSeconds(metadata.expiresInSeconds);
  const maxReads = clampReadLimit(metadata.maxReads ?? DEFAULT_READ_LIMIT);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  return {
    ok: true,
    value: {
      id,
      encryptionMode,
      payload,
      attachments,
      totalSize,
      maxReads,
      expiresAt,
      serverKeyShare,
      passwordProtection: passwordProtectionValidation.value
    }
  };
}

function invalid(message, status = 400) {
  return {
    ok: false,
    status,
    message
  };
}

function methodNotAllowed(allowedMethods) {
  const headers = new Headers(JSON_HEADERS);
  headers.set("Allow", allowedMethods.join(", "));
  return new Response(
    JSON.stringify({
      error: "method_not_allowed",
      message: "Method not allowed"
    }),
    {
      status: 405,
      headers
    }
  );
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
}

function validatePasswordGate(request, passwordProtection) {
  const validation = validatePasswordProtection(passwordProtection);
  if (!validation.ok) {
    return json({ error: "gone", message: "Message password protection is unavailable" }, 410);
  }

  if (!validation.value) {
    return null;
  }

  const suppliedProof = request.headers.get(PASSWORD_PROOF_HEADER) || "";
  if (!isValidKeyShare(suppliedProof)) {
    return passwordErrorResponse(validation.value, "password_required", "Password required");
  }

  if (!constantTimeEqual(suppliedProof, validation.value.verifier)) {
    return passwordErrorResponse(validation.value, "invalid_password", "Invalid password");
  }

  return null;
}

function passwordErrorResponse(passwordProtection, error, message) {
  return json(
    {
      error,
      message,
      passwordProtection: {
        algorithm: passwordProtection.algorithm,
        salt: passwordProtection.salt,
        iterations: passwordProtection.iterations
      }
    },
    401
  );
}

function validatePasswordProtection(passwordProtection) {
  if (passwordProtection == null) {
    return { ok: true, value: null };
  }

  if (!passwordProtection || typeof passwordProtection !== "object") {
    return invalid("Invalid password protection metadata");
  }

  const salt = passwordProtection.salt;
  if (!isValidBase64UrlValue(salt, 16, 128)) {
    return invalid("Invalid password protection salt");
  }

  const verifier = passwordProtection.verifier;
  if (!isValidKeyShare(verifier)) {
    return invalid("Invalid password protection verifier");
  }

  const iterations = Number(passwordProtection.iterations);
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) {
    return invalid("Invalid password protection iterations");
  }

  const algorithm = typeof passwordProtection.algorithm === "string" && passwordProtection.algorithm
    ? passwordProtection.algorithm
    : "PBKDF2-SHA-256";

  return {
    ok: true,
    value: {
      algorithm,
      salt,
      verifier,
      iterations
    }
  };
}

function isExpired(message) {
  return Date.parse(message.expiresAt) <= Date.now();
}

function isConsumed(message) {
  return Number(message.burned) === 1 || Number(message.readCount) >= Number(message.maxReads || MAX_READ_LIMIT);
}

function isBurnedOrExpired(message) {
  return isConsumed(message) || isExpired(message);
}

async function markBurnedAndCleanup(env, message) {
  await env.DB.prepare("UPDATE messages SET burned = 1 WHERE id = ?1").bind(message.id).run();
  await cleanupMessageObjects(env, message.id, message.attachmentCount);
}

async function cleanupMessageObjects(env, id, attachmentCount) {
  const deletions = [env.BUCKET.delete(messagePayloadKey(id))];

  for (let index = 0; index < attachmentCount; index += 1) {
    deletions.push(env.BUCKET.delete(messageAttachmentKey(id, index)));
  }

  await Promise.allSettled(deletions);
}

function messagePayloadKey(id) {
  return `messages/${id}/payload.bin`;
}

function messageAttachmentKey(id, index) {
  return `messages/${id}/files/${index}.bin`;
}

function generateOpaqueId() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

function generateKeyShare() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

function isValidKeyShare(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isValidBase64UrlValue(value, minLength = 1, maxLength = 256) {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(value);
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }

  let mismatch = left.length === right.length ? 0 : 1;
  const maxLength = Math.max(left.length, right.length);

  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return mismatch === 0;
}

function base64UrlEncode(bytes) {
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

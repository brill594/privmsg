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
import {
  USAGE_COUNTER_METRICS,
  USAGE_COUNTER_SCOPE_DAY,
  USAGE_COUNTER_SCOPE_MONTH,
  USAGE_STATE_KEYS,
  addR2ClassA,
  addR2ClassB,
  addR2StorageBytes,
  addR2StorageMbSeconds,
  buildUsageSummary,
  calculateR2StorageMbSeconds,
  createUsageRecorder,
  evaluateUsage,
  getUsageWindow,
  hasAnyUsageLimit,
  hasUsageDeltas,
  mbSecondsToGbMonth,
  parseUsageLimits,
  recordD1Meta
} from "./usage.js";

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
        return await withUsageTracking(env, (usage) => handleCreate(request, env, usage));
      }

      if (url.pathname === "/api/create-bootstrap") {
        return handleCreateBootstrap(request);
      }

      if (url.pathname === "/api/enhanced-encryption/bootstrap") {
        return handleEnhancedBootstrap();
      }

      if (url.pathname === "/api/usage") {
        return await handleUsage(request, env);
      }

      const messageMatch = url.pathname.match(/^\/api\/message\/([A-Za-z0-9_-]{20,64})$/);
      if (messageMatch) {
        return await withUsageTracking(env, (usage) => handleGetMessage(request, messageMatch[1], env, ctx, usage));
      }

      const fileMatch = url.pathname.match(/^\/api\/message\/([A-Za-z0-9_-]{20,64})\/file\/(\d+)$/);
      if (fileMatch) {
        return await withUsageTracking(env, (usage) => handleGetFile(request, fileMatch[1], Number(fileMatch[2]), env, ctx, usage));
      }

      const accessKeyMatch = url.pathname.match(/^\/api\/message\/([A-Za-z0-9_-]{20,64})\/access-key$/);
      if (accessKeyMatch) {
        return await withUsageTracking(env, (usage) => handleIssueAccessKey(request, accessKeyMatch[1], env, usage));
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

async function handleCreate(request, env, usage) {
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
  const payloadText = JSON.stringify(payloadObject);
  const storedBytes = new TextEncoder().encode(payloadText).byteLength + totalEncryptedSize;
  const now = new Date();
  const nowIso = now.toISOString();
  const usageLimitError = await ensureUsageBudget(
    env,
    {
      d1RowsWrittenDaily: 1,
      d1StorageBytes: estimateMessageMetadataBytes(id, expiresAt),
      r2ClassAOpsMonthly: attachments.length + 1,
      r2StorageBytes: storedBytes,
      r2StorageGbMonth: mbSecondsToGbMonth(calculateR2StorageMbSeconds(storedBytes, now.getTime(), projectedR2StorageEndMs(expiresAt, now)))
    },
    now
  );

  if (usageLimitError) {
    return usageLimitError;
  }

  const messageRecord = {
    id,
    attachmentCount: attachments.length,
    totalSize,
    storedBytes,
    maxReads,
    readCount: 0,
    createdAt: nowIso,
    expiresAt,
    storageProjectionMonth: getUsageWindow(now).monthKey
  };

  try {
    await d1Run(
      env,
      usage,
      `
        INSERT INTO messages (
          id,
          attachment_count,
          total_size,
          stored_bytes,
          max_reads,
          read_count,
          created_at,
          expires_at,
          burned,
          objects_deleted,
          storage_projection_month
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0, ?9)
      `,
      messageRecord.id,
      messageRecord.attachmentCount,
      messageRecord.totalSize,
      messageRecord.storedBytes,
      messageRecord.maxReads,
      messageRecord.readCount,
      messageRecord.createdAt,
      messageRecord.expiresAt,
      messageRecord.storageProjectionMonth
    );
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      return json({ error: "conflict", message: "Message id already exists" }, 409);
    }
    throw error;
  }

  try {
    await putObject(env, usage, messagePayloadKey(id), payloadText, {
      httpMetadata: {
        contentType: "application/json"
      }
    });

    for (const attachment of attachmentBuffers) {
      await putObject(env, usage, messageAttachmentKey(id, attachment.index), attachment.data, {
        httpMetadata: {
          contentType: "application/octet-stream"
        }
      });
    }
    addR2StorageBytes(usage, storedBytes);
    addR2StorageMbSeconds(
      usage,
      calculateR2StorageMbSeconds(storedBytes, now.getTime(), projectedR2StorageEndMs(expiresAt, now))
    );
  } catch (error) {
    await d1Run(env, usage, "DELETE FROM messages WHERE id = ?1", id);
    await cleanupMessageObjects(env, null, {
      id,
      attachmentCount: attachments.length,
      storedBytes
    });
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

async function handleUsage(request, env) {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  const now = new Date();
  const snapshot = await getUsageSnapshot(env, now);
  return json(buildUsageSummary(snapshot, parseUsageLimits(env), now));
}

async function handleGetMessage(request, id, env, ctx, usage) {
  if (!isValidMessageId(id)) {
    return json({ error: "invalid_request", message: "Invalid message id" }, 400);
  }

  const usageLimitError = await ensureUsageBudget(
    env,
    {
      d1RowsReadDaily: 1,
      r2ClassBOpsMonthly: 1
    }
  );
  if (usageLimitError) {
    return usageLimitError;
  }

  const message = await getMessageRecord(env, id, usage);
  if (!message) {
    return json({ error: "not_found", message: "Message not found" }, 404);
  }

  if (isBurnedOrExpired(message)) {
    ctx.waitUntil(markBurnedAndCleanup(env, message));
    return json({ error: "gone", message: "Message has already been burned" }, 410);
  }

  const payload = await getStoredPayload(env, id, usage);
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

async function handleGetFile(request, id, index, env, ctx, usage) {
  if (!isValidMessageId(id) || !Number.isInteger(index) || index < 0) {
    return json({ error: "invalid_request", message: "Invalid attachment request" }, 400);
  }

  const usageLimitError = await ensureUsageBudget(
    env,
    {
      d1RowsReadDaily: 1,
      r2ClassBOpsMonthly: 2
    }
  );
  if (usageLimitError) {
    return usageLimitError;
  }

  const message = await getMessageRecord(env, id, usage);
  if (!message) {
    return json({ error: "not_found", message: "Message not found" }, 404);
  }

  if (isBurnedOrExpired(message)) {
    ctx.waitUntil(markBurnedAndCleanup(env, message));
    return json({ error: "gone", message: "Message has already been burned" }, 410);
  }

  const payload = await getStoredPayload(env, id, usage);
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

  const attachment = await getObject(env, usage, messageAttachmentKey(id, index));
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

async function handleIssueAccessKey(request, id, env, usage) {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  if (!isValidMessageId(id)) {
    return json({ error: "invalid_request", message: "Invalid message id" }, 400);
  }

  const usageLimitError = await ensureUsageBudget(
    env,
    {
      d1RowsReadDaily: 3,
      d1RowsWrittenDaily: 1,
      r2ClassBOpsMonthly: 1
    }
  );
  if (usageLimitError) {
    return usageLimitError;
  }

  const message = await getMessageRecord(env, id, usage);
  if (!message) {
    return json({ error: "not_found", message: "Message not found" }, 404);
  }

  if (isConsumed(message) || isExpired(message)) {
    await markBurnedAndCleanup(env, message);
    return json({ error: "gone", message: "Message has already been burned" }, 410);
  }

  const payload = await getStoredPayload(env, id, usage);
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

  const updateResult = await d1Run(
    env,
    usage,
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
    `,
    id,
    new Date().toISOString()
  );

  if ((updateResult.meta?.changes || 0) === 0) {
    const latestMessage = await getMessageRecord(env, id, usage);
    if (!latestMessage) {
      return json({ error: "not_found", message: "Message not found" }, 404);
    }

    if (isConsumed(latestMessage) || isExpired(latestMessage)) {
      await markBurnedAndCleanup(env, latestMessage);
      return json({ error: "gone", message: "Message has already been burned" }, 410);
    }
  }

  const updatedMessage = await getMessageRecord(env, id, usage);
  if (!updatedMessage) {
    return json({ error: "not_found", message: "Message not found" }, 404);
  }

  const shouldBurn = isConsumed(updatedMessage);
  if (shouldBurn) {
    await cleanupMessageObjects(env, usage, updatedMessage);
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

async function getMessageRecord(env, id, usage = null) {
  const row = await d1First(
    env,
    usage,
    `
      SELECT
        id,
        attachment_count AS attachmentCount,
        total_size AS totalSize,
        stored_bytes AS storedBytes,
        max_reads AS maxReads,
        read_count AS readCount,
        created_at AS createdAt,
        expires_at AS expiresAt,
        burned,
        objects_deleted AS objectsDeleted,
        storage_projection_month AS storageProjectionMonth
      FROM messages
      WHERE id = ?1
      LIMIT 1
    `,
    id
  );

  return row || null;
}

async function getStoredPayload(env, id, usage = null) {
  const payloadObject = await getObject(env, usage, messagePayloadKey(id));
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
  const usage = createUsageRecorder();

  try {
    await d1Run(env, usage, "UPDATE messages SET burned = 1 WHERE id = ?1", message.id);
    await cleanupMessageObjects(env, usage, message);
  } finally {
    await commitUsage(env, usage);
  }
}

async function cleanupMessageObjects(env, usage, message) {
  const id = message.id;
  const attachmentCount = Number(message.attachmentCount) || 0;
  const deletions = [env.BUCKET.delete(messagePayloadKey(id))];

  if ((Number(message.objectsDeleted) || 0) === 0) {
    const result = await d1Run(
      env,
      usage,
      "UPDATE messages SET objects_deleted = 1 WHERE id = ?1 AND objects_deleted = 0",
      id
    );

    if ((result.meta?.changes || 0) > 0) {
      if (usage) {
        const storedBytes = Number(message.storedBytes) || 0;
        addR2StorageBytes(usage, -storedBytes);

        if (message.storageProjectionMonth === getUsageWindow(new Date()).monthKey) {
          addR2StorageMbSeconds(
            usage,
            -calculateR2StorageMbSeconds(storedBytes, Date.now(), projectedR2StorageEndMs(message.expiresAt))
          );
        }
      }

      message.objectsDeleted = 1;
    }
  }

  for (let index = 0; index < attachmentCount; index += 1) {
    deletions.push(env.BUCKET.delete(messageAttachmentKey(id, index)));
  }

  await Promise.allSettled(deletions);
}

async function withUsageTracking(env, operation) {
  const usage = createUsageRecorder();

  try {
    return await operation(usage);
  } finally {
    await commitUsage(env, usage);
  }
}

async function ensureUsageBudget(env, projectedUsage, now = new Date()) {
  const limits = parseUsageLimits(env);
  if (!hasAnyUsageLimit(limits)) {
    return null;
  }

  const snapshot = await getUsageSnapshot(env, now);
  const evaluation = evaluateUsage(snapshot, limits, projectedUsage);

  if (evaluation.breaches.length === 0) {
    return null;
  }

  return json(
    {
      error: "usage_limit_exceeded",
      message: "Configured usage limit exceeded",
      breaches: evaluation.breaches,
      usage: buildUsageSummary(snapshot, limits, now)
    },
    503
  );
}

async function getUsageSnapshot(env, now = new Date()) {
  await ensureCurrentMonthStorageProjection(env, now);

  const { dayKey, monthKey } = getUsageWindow(now);
  const countersResult = await env.DB.prepare(
    `
      SELECT scope, period_key AS periodKey, metric, value
      FROM usage_counters
      WHERE (scope = ?1 AND period_key = ?2) OR (scope = ?3 AND period_key = ?4)
    `
  )
    .bind(USAGE_COUNTER_SCOPE_DAY, dayKey, USAGE_COUNTER_SCOPE_MONTH, monthKey)
    .all();

  const statesResult = await env.DB.prepare(
    `
      SELECT key, value
      FROM usage_state
      WHERE key = ?1 OR key = ?2
    `
  )
    .bind(USAGE_STATE_KEYS.D1_STORAGE_BYTES, USAGE_STATE_KEYS.R2_STORAGE_BYTES)
    .all();

  const snapshot = {
    d1RowsReadDaily: 0,
    d1RowsWrittenDaily: 0,
    d1StorageBytes: 0,
    r2ClassAOpsMonthly: 0,
    r2ClassBOpsMonthly: 0,
    r2StorageBytes: 0,
    r2StorageGbMonth: 0
  };

  for (const row of countersResult.results || []) {
    if (row.scope === USAGE_COUNTER_SCOPE_DAY && row.metric === USAGE_COUNTER_METRICS.D1_ROWS_READ) {
      snapshot.d1RowsReadDaily = Number(row.value) || 0;
      continue;
    }

    if (row.scope === USAGE_COUNTER_SCOPE_DAY && row.metric === USAGE_COUNTER_METRICS.D1_ROWS_WRITTEN) {
      snapshot.d1RowsWrittenDaily = Number(row.value) || 0;
      continue;
    }

    if (row.scope === USAGE_COUNTER_SCOPE_MONTH && row.metric === USAGE_COUNTER_METRICS.R2_CLASS_A_OPS) {
      snapshot.r2ClassAOpsMonthly = Number(row.value) || 0;
      continue;
    }

    if (row.scope === USAGE_COUNTER_SCOPE_MONTH && row.metric === USAGE_COUNTER_METRICS.R2_CLASS_B_OPS) {
      snapshot.r2ClassBOpsMonthly = Number(row.value) || 0;
      continue;
    }

    if (row.scope === USAGE_COUNTER_SCOPE_MONTH && row.metric === USAGE_COUNTER_METRICS.R2_STORAGE_MB_SECONDS) {
      snapshot.r2StorageGbMonth = mbSecondsToGbMonth(Number(row.value) || 0);
    }
  }

  for (const row of statesResult.results || []) {
    if (row.key === USAGE_STATE_KEYS.D1_STORAGE_BYTES) {
      snapshot.d1StorageBytes = Number(row.value) || 0;
      continue;
    }

    if (row.key === USAGE_STATE_KEYS.R2_STORAGE_BYTES) {
      snapshot.r2StorageBytes = Number(row.value) || 0;
    }
  }

  return snapshot;
}

async function ensureCurrentMonthStorageProjection(env, now = new Date()) {
  const { monthKey, monthStartMs, nextMonthStartMs } = getUsageWindow(now);
  const result = await env.DB.prepare(
    `
      SELECT
        id,
        created_at AS createdAt,
        expires_at AS expiresAt,
        stored_bytes AS storedBytes
      FROM messages
      WHERE
        objects_deleted = 0
        AND expires_at > ?1
        AND (storage_projection_month IS NULL OR storage_projection_month != ?2)
    `
  )
    .bind(now.toISOString(), monthKey)
    .all();

  const rows = result.results || [];
  if (rows.length === 0) {
    return;
  }

  for (const row of rows) {
    const updateResult = await env.DB.prepare(
      `
        UPDATE messages
        SET storage_projection_month = ?2
        WHERE id = ?1 AND (storage_projection_month IS NULL OR storage_projection_month != ?2)
      `
    )
      .bind(row.id, monthKey)
      .run();

    if ((updateResult.meta?.changes || 0) === 0) {
      continue;
    }

    const projectedMbSeconds = calculateR2StorageMbSeconds(
      row.storedBytes,
      Math.max(Date.parse(row.createdAt), monthStartMs),
      Math.min(Date.parse(row.expiresAt), nextMonthStartMs)
    );

    if (projectedMbSeconds > 0) {
      await incrementUsageCounter(
        env,
        USAGE_COUNTER_SCOPE_MONTH,
        monthKey,
        USAGE_COUNTER_METRICS.R2_STORAGE_MB_SECONDS,
        projectedMbSeconds,
        now.toISOString()
      );
    }
  }
}

async function commitUsage(env, usage, now = new Date()) {
  if (!hasUsageDeltas(usage)) {
    return;
  }

  const { dayKey, monthKey } = getUsageWindow(now);
  const updatedAt = now.toISOString();

  if (usage.d1RowsReadDaily) {
    await incrementUsageCounter(
      env,
      USAGE_COUNTER_SCOPE_DAY,
      dayKey,
      USAGE_COUNTER_METRICS.D1_ROWS_READ,
      usage.d1RowsReadDaily,
      updatedAt
    );
  }

  if (usage.d1RowsWrittenDaily) {
    await incrementUsageCounter(
      env,
      USAGE_COUNTER_SCOPE_DAY,
      dayKey,
      USAGE_COUNTER_METRICS.D1_ROWS_WRITTEN,
      usage.d1RowsWrittenDaily,
      updatedAt
    );
  }

  if (usage.d1StorageBytesObserved !== null) {
    await setUsageState(env, USAGE_STATE_KEYS.D1_STORAGE_BYTES, usage.d1StorageBytesObserved, updatedAt);
  }

  if (usage.r2ClassAOpsMonthly) {
    await incrementUsageCounter(
      env,
      USAGE_COUNTER_SCOPE_MONTH,
      monthKey,
      USAGE_COUNTER_METRICS.R2_CLASS_A_OPS,
      usage.r2ClassAOpsMonthly,
      updatedAt
    );
  }

  if (usage.r2ClassBOpsMonthly) {
    await incrementUsageCounter(
      env,
      USAGE_COUNTER_SCOPE_MONTH,
      monthKey,
      USAGE_COUNTER_METRICS.R2_CLASS_B_OPS,
      usage.r2ClassBOpsMonthly,
      updatedAt
    );
  }

  if (usage.r2StorageMbSecondsMonthly) {
    await incrementUsageCounter(
      env,
      USAGE_COUNTER_SCOPE_MONTH,
      monthKey,
      USAGE_COUNTER_METRICS.R2_STORAGE_MB_SECONDS,
      usage.r2StorageMbSecondsMonthly,
      updatedAt
    );
  }

  if (usage.r2StorageBytesDelta) {
    await incrementUsageState(env, USAGE_STATE_KEYS.R2_STORAGE_BYTES, usage.r2StorageBytesDelta, updatedAt);
  }
}

async function incrementUsageCounter(env, scope, periodKey, metric, value, updatedAt) {
  await env.DB.prepare(
    `
      INSERT INTO usage_counters (scope, period_key, metric, value, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(scope, period_key, metric)
      DO UPDATE SET
        value = usage_counters.value + excluded.value,
        updated_at = excluded.updated_at
    `
  )
    .bind(scope, periodKey, metric, value, updatedAt)
    .run();
}

async function setUsageState(env, key, value, updatedAt) {
  await env.DB.prepare(
    `
      INSERT INTO usage_state (key, value, updated_at)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(key)
      DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `
  )
    .bind(key, value, updatedAt)
    .run();
}

async function incrementUsageState(env, key, delta, updatedAt) {
  await env.DB.prepare(
    `
      INSERT INTO usage_state (key, value, updated_at)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(key)
      DO UPDATE SET
        value = MAX(0, usage_state.value + excluded.value),
        updated_at = excluded.updated_at
    `
  )
    .bind(key, delta, updatedAt)
    .run();
}

async function d1First(env, usage, sql, ...params) {
  const result = await env.DB.prepare(sql).bind(...params).all();
  recordD1Meta(usage, result.meta);
  return result.results?.[0] || null;
}

async function d1Run(env, usage, sql, ...params) {
  const result = await env.DB.prepare(sql).bind(...params).run();
  recordD1Meta(usage, result.meta);
  return result;
}

async function getObject(env, usage, key) {
  const object = await env.BUCKET.get(key);
  addR2ClassB(usage, 1);
  return object;
}

async function putObject(env, usage, key, value, options = {}) {
  const result = await env.BUCKET.put(key, value, options);
  addR2ClassA(usage, 1);
  return result;
}

function estimateMessageMetadataBytes(id, expiresAt) {
  return 512 + String(id || "").length + String(expiresAt || "").length;
}

function projectedR2StorageEndMs(expiresAt, now = new Date()) {
  return Math.min(Date.parse(expiresAt), getUsageWindow(now).nextMonthStartMs);
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

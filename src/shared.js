export const MAX_TOTAL_SIZE_BYTES = 50 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const MIN_TTL_SECONDS = 60 * 60;
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MIN_READ_LIMIT = 1;
export const DEFAULT_READ_LIMIT = 1;
export const MAX_READ_LIMIT = 20;
export const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
export const ENCRYPTION_MODE_STANDARD = "standard";
export const ENCRYPTION_MODE_ENHANCED = "enhanced";

export const ALLOWED_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "mp4",
  "webm",
  "mov",
  "txt",
  "pdf",
  "pk8"
]);

export const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "text/plain",
  "application/pdf",
  "application/pkcs8"
]);

const OCTET_STREAM_COMPATIBLE_EXTENSIONS = new Set(["pk8"]);

export function getFileExtension(filename) {
  if (typeof filename !== "string") {
    return "";
  }

  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1 || lastDot === filename.length - 1) {
    return "";
  }

  return filename.slice(lastDot + 1).toLowerCase();
}

export function isAllowedAttachment({ name, type = "" }) {
  const extension = getFileExtension(name);
  const normalizedType = String(type || "").toLowerCase();
  const extensionAllowed = ALLOWED_EXTENSIONS.has(extension);
  const typeAllowed =
    !normalizedType ||
    ALLOWED_MIME_TYPES.has(normalizedType) ||
    (normalizedType === "application/octet-stream" && OCTET_STREAM_COMPATIBLE_EXTENSIONS.has(extension));
  return extensionAllowed && typeAllowed;
}

export function getPreviewKind({ name, type = "" }) {
  const extension = getFileExtension(name);
  const normalizedType = String(type || "").toLowerCase();

  if (normalizedType.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif"].includes(extension)) {
    return "image";
  }

  if (
    normalizedType === "video/mp4" ||
    normalizedType === "video/webm" ||
    normalizedType === "video/quicktime" ||
    ["mp4", "webm", "mov"].includes(extension)
  ) {
    return "video";
  }

  if (normalizedType === "text/plain" || extension === "txt") {
    return "text";
  }

  if (normalizedType === "application/pdf" || extension === "pdf") {
    return "pdf";
  }

  return "download";
}

export function clampTtlSeconds(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_TTL_SECONDS;
  }

  const flooredValue = Math.floor(numericValue);
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, flooredValue));
}

export function isValidMessageId(id) {
  return MESSAGE_ID_PATTERN.test(String(id || ""));
}

export function normalizeEncryptionMode(value) {
  return value === ENCRYPTION_MODE_ENHANCED ? ENCRYPTION_MODE_ENHANCED : ENCRYPTION_MODE_STANDARD;
}

export function clampReadLimit(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_READ_LIMIT;
  }

  const flooredValue = Math.floor(numericValue);
  return Math.min(MAX_READ_LIMIT, Math.max(MIN_READ_LIMIT, flooredValue));
}

export function approximateBytesFromBase64Url(value) {
  if (typeof value !== "string") {
    return 0;
  }

  return Math.floor((value.length * 3) / 4);
}

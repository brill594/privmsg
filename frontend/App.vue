<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import { ENCRYPTION_MODE_ENHANCED, ENCRYPTION_MODE_STANDARD, getPreviewKind } from "../src/shared.js";
import {
  DEFAULT_READ_LIMIT,
  MAX_READ_LIMIT,
  base64UrlEncode,
  base64UrlDecode,
  clampReadLimit,
  decryptBytes,
  deriveAccessKeyMaterial,
  decryptJsonValue,
  encryptAttachment,
  encryptBytes,
  encryptJsonValue,
  encryptPayload,
  exportX25519PrivateKey,
  exportX25519PublicKey,
  formatBytes,
  generateX25519KeyPair,
  importX25519PrivateKey,
  importX25519PublicKey,
  inferMimeType,
  deriveX25519SharedSecret,
  normalizeKeyText,
  readMessageIdFromPath,
  safeReadJson,
  validateDraft
} from "./lib/privmsg.js";
import { detectInitialLocale, messages, persistLocale } from "./i18n.js";

import Button from "./components/ui/Button.vue";
import ThemeToggle from "./components/ThemeToggle.vue";

const THEME_KEY = "privmsg.theme";
const ENHANCED_PUBLIC_KEY_KEY = "privmsg.enhanced-public-key";

const policyMode = window.location.pathname === "/policy" || window.location.pathname === "/policy/";
const readerMode = window.location.pathname.startsWith("/m/");

const locale = ref(detectInitialLocale());
const text = computed(() => messages[locale.value] || messages.zh);
const ttlOptions = computed(() => text.value.ttlOptions);

const composer = reactive({
  message: "",
  files: [],
  ttlSeconds: 86400,
  maxReads: DEFAULT_READ_LIMIT,
  encryptionMode: ENCRYPTION_MODE_STANDARD,
  recipientPublicKey: ""
});

const composerStatus = reactive({
  message: "",
  tone: "progress",
  renderer: null
});

const enhancedBootstrap = reactive({
  status: "idle",
  manifest: null,
  loadedBytes: 0,
  totalBytes: 0,
  generatedPublicKey: getStoredEnhancedPublicKey(),
  privateKeyFileName: "",
  errorMessage: "",
  errorRenderer: null
});

const shareLink = ref("");
const isCreating = ref(false);
const fileInput = ref(null);
const readerPrivateKeyInput = ref(null);
const isPreviewExpanded = ref(false);

const reader = reactive({
  statusMessage: "",
  statusTone: "progress",
  statusRenderer: null,
  loaded: false,
  message: "",
  messageRenderer: null,
  attachments: []
});

const preview = reactive({
  activeUrl: "",
  kind: "",
  name: "",
  sourceText: "",
  visible: false
});

const readerPrivateKeyPrompt = reactive({
  visible: false,
  selectedFileName: "",
  errorMessage: "",
  errorRenderer: null
});

let enhancedBootstrapPromise = null;
let pendingPrivateKeyRequest = null;

/* ---------- theme ---------- */

function getStoredEnhancedPublicKey() {
  if (typeof window === "undefined") {
    return "";
  }

  return localStorage.getItem(ENHANCED_PUBLIC_KEY_KEY) || "";
}

function getInitialTheme() {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light") return false;
  if (stored === "dark") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

const isDark = ref(getInitialTheme());
applyTheme();

function toggleTheme() {
  isDark.value = !isDark.value;
  localStorage.setItem(THEME_KEY, isDark.value ? "dark" : "light");
  applyTheme();
}

function applyTheme() {
  document.documentElement.classList.toggle("dark", isDark.value);
}

/* ---------- computed ---------- */

const selectedTotalSize = computed(() => composer.files.reduce((sum, file) => sum + file.size, 0));
const isEnhancedEncryptionEnabled = computed(() => composer.encryptionMode === ENCRYPTION_MODE_ENHANCED);
const selectedFileSummary = computed(() => {
  if (!composer.files.length) {
    return text.value.composer.noFiles;
  }

  return text.value.composer.selectedFiles(composer.files.length, formatBytes(selectedTotalSize.value));
});
const composerStatusMessage = computed(() => resolveLocalizedText(composerStatus.message, composerStatus.renderer));
const enhancedBootstrapReady = computed(() => enhancedBootstrap.status === "ready");
const enhancedBootstrapProgressPercent = computed(() => {
  if (!enhancedBootstrap.totalBytes) {
    return enhancedBootstrap.status === "ready" ? 100 : 0;
  }

  return Math.min(100, Math.round((enhancedBootstrap.loadedBytes / enhancedBootstrap.totalBytes) * 100));
});
const enhancedBootstrapMessage = computed(() => {
  if (!isEnhancedEncryptionEnabled.value) {
    return "";
  }

  if (enhancedBootstrap.status === "loading") {
    return text.value.composer.enhanced.bootstrapProgress(
      enhancedBootstrap.loadedBytes,
      enhancedBootstrap.totalBytes
    );
  }

  if (enhancedBootstrap.status === "ready" && enhancedBootstrap.manifest) {
    return text.value.composer.enhanced.bootstrapReadyInline(enhancedBootstrap.manifest.version);
  }

  if (enhancedBootstrap.status === "error") {
    return resolveLocalizedText(enhancedBootstrap.errorMessage, enhancedBootstrap.errorRenderer);
  }

  return text.value.composer.enhanced.bootstrapIdle;
});
const previewPlaceholder = computed(() => text.value.reader.previewPlaceholder);
const readerSummary = computed(() =>
  reader.attachments.length ? text.value.reader.summary(reader.attachments.length) : text.value.reader.noAttachments
);
const hasExpandablePreview = computed(() => preview.visible && ["text", "image", "video", "pdf"].includes(preview.kind));
const readerStatusMessage = computed(() => resolveLocalizedText(reader.statusMessage, reader.statusRenderer));
const readerPrivateKeyPromptError = computed(() =>
  resolveLocalizedText(readerPrivateKeyPrompt.errorMessage, readerPrivateKeyPrompt.errorRenderer)
);
const readerMessage = computed(() => {
  if (!reader.loaded) {
    return text.value.reader.waitingBody;
  }

  return resolveLocalizedText(reader.message, reader.messageRenderer) || text.value.reader.emptyBody;
});
const previewTextContent = computed(() => {
  if (preview.kind !== "text") {
    return "";
  }

  if (preview.sourceText.length > 200000) {
    return `${preview.sourceText.slice(0, 200000)}\n\n${text.value.reader.previewTruncated}`;
  }

  return preview.sourceText;
});
const previewDialogTitle = computed(() => preview.name || text.value.reader.previewTitle);
const footerHref = computed(() => (policyMode ? "/" : "/policy"));
const footerLabel = computed(() => (policyMode ? text.value.footer.home : text.value.footer.legal));

/* ---------- status tone classes ---------- */

function toneClasses(tone) {
  const map = {
    progress: "bg-primary/10 text-primary border-primary/20",
    success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
    warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
    error: "bg-destructive/10 text-destructive border-destructive/20"
  };
  return map[tone] || map.progress;
}

function resolveLocalizedText(message, renderer) {
  return typeof renderer === "function" ? renderer(text.value) : message;
}

function createLocalizedError(renderer) {
  const error = new Error("");
  error.localizedRenderer = renderer;
  return error;
}

function setEnhancedBootstrapError(messageOrRenderer) {
  enhancedBootstrap.status = "error";
  enhancedBootstrap.errorMessage = typeof messageOrRenderer === "function" ? "" : messageOrRenderer;
  enhancedBootstrap.errorRenderer = typeof messageOrRenderer === "function" ? messageOrRenderer : null;
}

function setReaderPrivateKeyPromptError(messageOrRenderer = "") {
  readerPrivateKeyPrompt.errorMessage = typeof messageOrRenderer === "function" ? "" : messageOrRenderer;
  readerPrivateKeyPrompt.errorRenderer = typeof messageOrRenderer === "function" ? messageOrRenderer : null;
}

/* ---------- lifecycle ---------- */

watch(
  locale,
  () => {
    persistLocale(locale.value);
    document.documentElement.lang = locale.value === "zh" ? "zh-CN" : "en";

    if (
      !readerMode &&
      !policyMode &&
      !isCreating.value &&
      !shareLink.value &&
      !composerStatus.message &&
      !composerStatus.renderer
    ) {
      setComposerStatus((currentText) => currentText.composer.initialStatus, "progress");
    }

    if (readerMode && !reader.loaded && !reader.statusMessage && !reader.statusRenderer) {
      setReaderStatus((currentText) => currentText.reader.initialStatus, "progress");
    }
  },
  { immediate: true }
);

watch(isPreviewExpanded, (expanded) => {
  if (typeof document !== "undefined") {
    document.body.style.overflow = expanded ? "hidden" : "";
  }
});

watch(
  () => composer.encryptionMode,
  (mode) => {
    if (mode === ENCRYPTION_MODE_ENHANCED) {
      void ensureEnhancedBootstrap().catch(() => {});
    }
  }
);

onMounted(() => {
  window.addEventListener("keydown", handleWindowKeydown);

  if (readerMode) {
    void loadMessage();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleWindowKeydown);
  document.body.style.overflow = "";
  clearPreview();
  cancelReaderPrivateKeyPrompt(true);
});

/* ---------- helpers ---------- */

function setComposerStatus(messageOrRenderer, tone = "progress") {
  composerStatus.message = typeof messageOrRenderer === "function" ? "" : messageOrRenderer;
  composerStatus.tone = tone;
  composerStatus.renderer = typeof messageOrRenderer === "function" ? messageOrRenderer : null;
}

function setReaderStatus(messageOrRenderer, tone = "progress") {
  reader.statusMessage = typeof messageOrRenderer === "function" ? "" : messageOrRenderer;
  reader.statusTone = tone;
  reader.statusRenderer = typeof messageOrRenderer === "function" ? messageOrRenderer : null;
}

function setReaderMessage(messageOrRenderer = "") {
  reader.message = typeof messageOrRenderer === "function" ? "" : messageOrRenderer;
  reader.messageRenderer = typeof messageOrRenderer === "function" ? messageOrRenderer : null;
}

function switchLocale(nextLocale) {
  locale.value = nextLocale;
}

function openExpandedPreview() {
  if (hasExpandablePreview.value) {
    isPreviewExpanded.value = true;
  }
}

function closeExpandedPreview() {
  isPreviewExpanded.value = false;
}

function handleWindowKeydown(event) {
  if (event.key === "Escape" && isPreviewExpanded.value) {
    closeExpandedPreview();
  }
}

function onFileChange(event) {
  composer.files = Array.from(event.target.files || []);
}

function openFilePicker() {
  fileInput.value?.click();
}

function normalizeMaxReads() {
  composer.maxReads = clampReadLimit(composer.maxReads);
}

function buildAttachmentMeta(file, index) {
  return {
    index,
    name: file.name,
    type: file.type || inferMimeType(file.name),
    size: file.size
  };
}

function mergeUint8Chunks(chunks, totalBytes) {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return merged;
}

async function ensureEnhancedBootstrap(force = false) {
  if (enhancedBootstrap.status === "ready" && enhancedBootstrap.manifest && !force) {
    return enhancedBootstrap.manifest;
  }

  if (enhancedBootstrap.status === "loading" && enhancedBootstrapPromise) {
    return enhancedBootstrapPromise;
  }

  enhancedBootstrap.status = "loading";
  enhancedBootstrap.manifest = null;
  enhancedBootstrap.loadedBytes = 0;
  enhancedBootstrap.totalBytes = 0;
  enhancedBootstrap.errorMessage = "";
  enhancedBootstrap.errorRenderer = null;

  enhancedBootstrapPromise = (async () => {
    try {
      const response = await fetch("/api/enhanced-encryption/bootstrap", {
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        throw createLocalizedError((currentText) => currentText.composer.enhanced.errors.bootstrapFailed);
      }

      const totalBytes = Number(response.headers.get("content-length") || 0);
      enhancedBootstrap.totalBytes = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;

      const chunks = [];
      let loadedBytes = 0;

      if (response.body) {
        const streamReader = response.body.getReader();
        while (true) {
          const { done, value } = await streamReader.read();
          if (done) {
            break;
          }

          if (value) {
            chunks.push(value);
            loadedBytes += value.byteLength;
            enhancedBootstrap.loadedBytes = loadedBytes;
          }
        }
      } else {
        const data = new Uint8Array(await response.arrayBuffer());
        chunks.push(data);
        loadedBytes = data.byteLength;
        enhancedBootstrap.loadedBytes = loadedBytes;
      }

      const manifest = JSON.parse(new TextDecoder().decode(mergeUint8Chunks(chunks, loadedBytes)));
      enhancedBootstrap.status = "ready";
      enhancedBootstrap.manifest = manifest;
      enhancedBootstrap.loadedBytes = loadedBytes;
      enhancedBootstrap.totalBytes = enhancedBootstrap.totalBytes || loadedBytes;
      return manifest;
    } catch (error) {
      setEnhancedBootstrapError(
        error.localizedRenderer || error.message || ((currentText) => currentText.composer.enhanced.errors.bootstrapFailed)
      );
      throw error;
    } finally {
      enhancedBootstrapPromise = null;
    }
  })();

  return enhancedBootstrapPromise;
}

async function regenerateEnhancedBootstrap() {
  try {
    await ensureEnhancedBootstrap(true);
  } catch {
    // Section state already shows the failure.
  }
}

async function generateEnhancedKeyPairAndDownload() {
  try {
    await ensureEnhancedBootstrap();
    setComposerStatus((currentText) => currentText.composer.enhanced.generatingKeyPair);

    const keyPair = await generateX25519KeyPair();
    const publicKey = await exportX25519PublicKey(keyPair.publicKey);
    const privateKeyBytes = await exportX25519PrivateKey(keyPair.privateKey);
    const fileName = `privmsg-x25519-private-key-${new Date().toISOString().replaceAll(":", "-")}.pk8`;

    downloadBlobFile(new Blob([privateKeyBytes], { type: "application/pkcs8" }), fileName);
    enhancedBootstrap.generatedPublicKey = publicKey;
    enhancedBootstrap.privateKeyFileName = fileName;
    localStorage.setItem(ENHANCED_PUBLIC_KEY_KEY, publicKey);
    setComposerStatus((currentText) => currentText.composer.enhanced.keyPairReady(fileName), "success");
  } catch (error) {
    setComposerStatus(
      error.localizedRenderer || error.message || ((currentText) => currentText.composer.enhanced.errors.keyGenerationFailed),
      "error"
    );
  }
}

async function copyGeneratedPublicKey() {
  if (!enhancedBootstrap.generatedPublicKey) {
    return;
  }

  try {
    await navigator.clipboard.writeText(enhancedBootstrap.generatedPublicKey);
    setComposerStatus((currentText) => currentText.composer.enhanced.publicKeyCopied, "success");
  } catch {
    setComposerStatus((currentText) => currentText.composer.enhanced.publicKeyCopyFailed, "warning");
  }
}

async function resolveRecipientPublicKey() {
  composer.recipientPublicKey = normalizeKeyText(composer.recipientPublicKey);

  if (!composer.recipientPublicKey) {
    throw createLocalizedError((currentText) => currentText.composer.validation.missingRecipientPublicKey);
  }

  try {
    return await importX25519PublicKey(composer.recipientPublicKey);
  } catch {
    throw createLocalizedError((currentText) => currentText.composer.validation.invalidRecipientPublicKey);
  }
}

async function requestCreateBootstrap() {
  const response = await fetch("/api/create-bootstrap", {
    method: "POST",
    headers: {
      Accept: "application/json"
    }
  });

  const result = await safeReadJson(response);
  if (!response.ok) {
    if (result.message) {
      throw new Error(result.message);
    }

    throw createLocalizedError((currentText) => currentText.composer.errors.serverKeyBootstrapFailed);
  }

  if (typeof result.id !== "string" || typeof result.serverKeyShare !== "string") {
    throw createLocalizedError((currentText) => currentText.composer.errors.serverKeyBootstrapFailed);
  }

  return result;
}

async function requestAccessKey(messageId) {
  const response = await fetch(`/api/message/${messageId}/access-key`, {
    method: "POST",
    headers: {
      Accept: "application/json"
    }
  });

  const result = await safeReadJson(response);
  if (!response.ok) {
    if (result.message) {
      throw new Error(result.message);
    }

    throw createLocalizedError((currentText) => currentText.reader.errors.accessKeyFailed);
  }

  if (typeof result.serverKeyShare !== "string") {
    throw createLocalizedError((currentText) => currentText.reader.errors.invalidAccessKey);
  }

  return result;
}

async function createMessage() {
  const validationError = validateDraft(composer.message, composer.files, text.value.composer.validation);
  if (validationError) {
    setComposerStatus(validationError, "error");
    return;
  }

  isCreating.value = true;
  shareLink.value = "";

  try {
    setComposerStatus((currentText) => currentText.composer.requestingServerKey);

    const { id: messageId, serverKeyShare } = await requestCreateBootstrap();
    const serverKeyShareBytes = base64UrlDecode(serverKeyShare);
    if (serverKeyShareBytes.byteLength !== 32) {
      throw createLocalizedError((currentText) => currentText.composer.errors.serverKeyBootstrapFailed);
    }

    const localKeyShareBytes = crypto.getRandomValues(new Uint8Array(32));
    const accessKeyMaterial = await deriveAccessKeyMaterial(localKeyShareBytes, serverKeyShareBytes, messageId);
    const maxReads = clampReadLimit(composer.maxReads);
    const totalFiles = composer.files.length;
    const localKeyShare = base64UrlEncode(localKeyShareBytes);
    const encryptionMode = isEnhancedEncryptionEnabled.value ? ENCRYPTION_MODE_ENHANCED : ENCRYPTION_MODE_STANDARD;
    const encryptedAttachments = [];
    let totalSize = 0;
    let payloadPlaintext;

    if (encryptionMode === ENCRYPTION_MODE_ENHANCED) {
      const bootstrapManifest = await ensureEnhancedBootstrap();
      const recipientPublicKey = await resolveRecipientPublicKey();
      const attachmentMetadata = composer.files.map((file, index) => buildAttachmentMeta(file, index));

      setComposerStatus((currentText) => currentText.composer.enhanced.encryptMessage);

      const ephemeralKeyPair = await generateX25519KeyPair();
      const ephemeralPublicKey = await exportX25519PublicKey(ephemeralKeyPair.publicKey);
      const sharedSecretBytes = await deriveX25519SharedSecret(ephemeralKeyPair.privateKey, recipientPublicKey);
      const innerPayload = await encryptJsonValue(
        {
          version: 1,
          message: composer.message,
          attachments: attachmentMetadata
        },
        sharedSecretBytes,
        messageId,
        "x25519:payload"
      );
      const innerAttachmentEnvelopes = [];

      for (let index = 0; index < totalFiles; index += 1) {
        const file = composer.files[index];
        totalSize += file.size;

        setComposerStatus((currentText) => currentText.composer.enhanced.encryptAttachment(index, totalFiles, file.name));
        const firstPass = await encryptBytes(await file.arrayBuffer(), sharedSecretBytes, messageId, `x25519:file:${index}`);

        setComposerStatus((currentText) => currentText.composer.encryptAttachment(index, totalFiles, file.name));
        const secondPass = await encryptBytes(firstPass.ciphertext, accessKeyMaterial, messageId, `file:${index}`);
        encryptedAttachments.push({
          index,
          iv: secondPass.iv,
          encryptedBlob: new Blob([secondPass.ciphertext], {
            type: "application/octet-stream"
          })
        });
        innerAttachmentEnvelopes.push({
          index,
          iv: firstPass.iv
        });
      }

      payloadPlaintext = {
        version: 2,
        encryption: {
          mode: ENCRYPTION_MODE_ENHANCED,
          algorithm: bootstrapManifest.algorithm,
          resourceVersion: bootstrapManifest.version,
          ephemeralPublicKey,
          payload: innerPayload
        },
        attachments: innerAttachmentEnvelopes
      };
    } else {
      for (let index = 0; index < totalFiles; index += 1) {
        const file = composer.files[index];
        totalSize += file.size;
        setComposerStatus((currentText) => currentText.composer.encryptAttachment(index, totalFiles, file.name));
        encryptedAttachments.push(await encryptAttachment(file, index, accessKeyMaterial, messageId));
      }

      payloadPlaintext = {
        version: 1,
        message: composer.message,
        attachments: encryptedAttachments.map(({ meta }) => meta)
      };
    }

    setComposerStatus((currentText) => currentText.composer.encryptMessage);
    const payload = await encryptPayload(payloadPlaintext, accessKeyMaterial, messageId);

    const metadata = {
      id: messageId,
      serverKeyShare,
      encryptionMode,
      totalSize,
      expiresInSeconds: Number(composer.ttlSeconds),
      maxReads,
      payload,
      attachments: encryptedAttachments.map(({ index, iv, encryptedBlob }) => ({
        index,
        iv,
        encryptedSize: encryptedBlob.size
      }))
    };

    const formData = new FormData();
    formData.append("metadata", JSON.stringify(metadata));

    for (const attachment of encryptedAttachments) {
      formData.append(`file-${attachment.index}`, attachment.encryptedBlob, `${attachment.index}.bin`);
    }

    setComposerStatus((currentText) => currentText.composer.uploading);

    const response = await fetch("/api/create", {
      method: "POST",
      body: formData
    });

    const result = await response.json();
    if (!response.ok) {
      if (result.message) {
        throw new Error(result.message);
      }
      throw createLocalizedError((currentText) => currentText.composer.errors.createFailed);
    }

    shareLink.value = `${window.location.origin}/m/${messageId}#${localKeyShare}`;
    setComposerStatus((currentText) => currentText.composer.created(maxReads), "success");
  } catch (error) {
    setComposerStatus(
      error.localizedRenderer || error.message || ((currentText) => currentText.composer.errors.createFailed),
      "error"
    );
  } finally {
    isCreating.value = false;
  }
}

async function loadMessage() {
  try {
    reader.loaded = false;
    reader.attachments = [];
    setReaderMessage("");
    const messageId = readMessageIdFromPath();
    const localKeyShare = window.location.hash.slice(1);

    if (!messageId) {
      throw createLocalizedError((currentText) => currentText.reader.errors.missingMessageId);
    }

    if (!localKeyShare) {
      throw createLocalizedError((currentText) => currentText.reader.errors.missingDecryptionKey);
    }

    let localKeyShareBytes;
    try {
      localKeyShareBytes = base64UrlDecode(localKeyShare);
    } catch {
      throw createLocalizedError((currentText) => currentText.reader.errors.invalidDecryptionKey);
    }

    if (localKeyShareBytes.byteLength !== 32) {
      throw createLocalizedError((currentText) => currentText.reader.errors.invalidDecryptionKey);
    }

    setReaderStatus((currentText) => currentText.reader.fetching);

    const messageResponse = await fetch(`/api/message/${messageId}`, {
      headers: {
        Accept: "application/json"
      }
    });

    const envelope = await messageResponse.json();
    if (!messageResponse.ok) {
      if (envelope.message) {
        throw new Error(envelope.message);
      }
      throw createLocalizedError((currentText) => currentText.reader.errors.readFailed);
    }

    const encryptionMode = envelope.encryptionMode || ENCRYPTION_MODE_STANDARD;
    let readerPrivateKey = null;
    const outerAttachmentEnvelopes = new Map((envelope.attachments || []).map((item) => [item.index, item]));
    const encryptedAttachmentPayloads = new Map();

    if (encryptionMode === ENCRYPTION_MODE_ENHANCED) {
      setReaderStatus((currentText) => currentText.reader.selectPrivateKey);
      readerPrivateKey = await requestReaderPrivateKey();
    }

    if (outerAttachmentEnvelopes.size > 0) {
      setReaderStatus((currentText) => currentText.reader.fetchingAttachments);

      for (const attachment of envelope.attachments || []) {
        const fileResponse = await fetch(`/api/message/${messageId}/file/${attachment.index}`);
        if (!fileResponse.ok) {
          const errorBody = await safeReadJson(fileResponse);
          if (errorBody.message) {
            throw new Error(errorBody.message);
          }

          throw createLocalizedError((currentText) => currentText.reader.errors.fetchAttachmentFailed(`#${attachment.index}`));
        }

        encryptedAttachmentPayloads.set(attachment.index, new Uint8Array(await fileResponse.arrayBuffer()));
      }
    }

    setReaderStatus((currentText) => currentText.reader.requestingAccessKey);
    const accessKeyResult = await requestAccessKey(messageId);
    const serverKeyShareBytes = base64UrlDecode(accessKeyResult.serverKeyShare);
    if (serverKeyShareBytes.byteLength !== 32) {
      throw createLocalizedError((currentText) => currentText.reader.errors.invalidAccessKey);
    }

    const accessKeyMaterial = await deriveAccessKeyMaterial(
      localKeyShareBytes,
      serverKeyShareBytes,
      messageId
    );

    if (encryptionMode === ENCRYPTION_MODE_ENHANCED) {
      setReaderStatus((currentText) => currentText.reader.decryptingOuterMessage);
    } else {
      setReaderStatus((currentText) => currentText.reader.decryptingMessage);
    }

    const payload = await decryptJsonValue(envelope.payload.ciphertext, envelope.payload.iv, accessKeyMaterial, messageId, "payload");
    let messageText = payload.message || "";
    let attachmentMetadata = payload.attachments || [];
    let enhancedAttachmentEnvelopes = null;
    let sharedSecretBytes = null;

    if (encryptionMode === ENCRYPTION_MODE_ENHANCED) {
      if (
        payload.encryption?.mode !== ENCRYPTION_MODE_ENHANCED ||
        !payload.encryption?.ephemeralPublicKey ||
        !payload.encryption?.payload
      ) {
        throw createLocalizedError((currentText) => currentText.reader.errors.invalidEnhancedEnvelope);
      }

      let senderPublicKey;
      try {
        senderPublicKey = await importX25519PublicKey(payload.encryption.ephemeralPublicKey);
      } catch {
        throw createLocalizedError((currentText) => currentText.reader.errors.invalidEnhancedEnvelope);
      }

      setReaderStatus((currentText) => currentText.reader.decryptingEnhancedMessage);
      sharedSecretBytes = await deriveX25519SharedSecret(readerPrivateKey, senderPublicKey);
      const innerPayload = await decryptJsonValue(
        payload.encryption.payload.ciphertext,
        payload.encryption.payload.iv,
        sharedSecretBytes,
        messageId,
        "x25519:payload"
      );

      messageText = innerPayload.message || "";
      attachmentMetadata = Array.isArray(innerPayload.attachments) ? innerPayload.attachments : [];
      enhancedAttachmentEnvelopes = new Map((payload.attachments || []).map((item) => [item.index, item]));
    }

    const decryptedAttachments = [];
    for (const attachment of attachmentMetadata) {
      const outerAttachmentEnvelope = outerAttachmentEnvelopes.get(attachment.index);
      if (!outerAttachmentEnvelope) {
        throw createLocalizedError((currentText) => currentText.reader.errors.missingAttachmentEnvelope(attachment.index));
      }

      const encryptedAttachmentPayload = encryptedAttachmentPayloads.get(attachment.index);
      if (!encryptedAttachmentPayload) {
        throw createLocalizedError((currentText) => currentText.reader.errors.fetchAttachmentFailed(attachment.name));
      }

      setReaderStatus((currentText) =>
        encryptionMode === ENCRYPTION_MODE_ENHANCED
          ? currentText.reader.decryptingOuterAttachment(attachment.name)
          : currentText.reader.decryptingAttachment(attachment.name)
      );

      let decryptedBytes = await decryptBytes(
        encryptedAttachmentPayload,
        outerAttachmentEnvelope.iv,
        accessKeyMaterial,
        messageId,
        `file:${attachment.index}`
      );

      if (encryptionMode === ENCRYPTION_MODE_ENHANCED) {
        const enhancedAttachmentEnvelope = enhancedAttachmentEnvelopes?.get(attachment.index);
        if (!enhancedAttachmentEnvelope?.iv) {
          throw createLocalizedError((currentText) => currentText.reader.errors.missingEnhancedAttachmentEnvelope(attachment.index));
        }

        setReaderStatus((currentText) => currentText.reader.decryptingEnhancedAttachment(attachment.name));
        decryptedBytes = await decryptBytes(
          decryptedBytes,
          enhancedAttachmentEnvelope.iv,
          sharedSecretBytes,
          messageId,
          `x25519:file:${attachment.index}`
        );
      }

      decryptedAttachments.push({
        ...attachment,
        blob: new Blob([decryptedBytes], {
          type: attachment.type || text.value.common.attachmentTypeFallback
        })
      });
    }

    if (accessKeyResult.burned) {
      setReaderStatus((currentText) => currentText.reader.burned, "success");
    } else {
      setReaderStatus((currentText) => currentText.reader.remaining(accessKeyResult.remainingReads), "success");
    }

    setReaderMessage(messageText);
    reader.attachments = decryptedAttachments;
    reader.loaded = true;
  } catch (error) {
    setReaderMessage((currentText) => currentText.reader.unavailable);
    reader.attachments = [];
    reader.loaded = true;
    setReaderStatus(
      error.localizedRenderer || error.message || ((currentText) => currentText.reader.errors.decryptFailed),
      "error"
    );
  }
}

async function copyShareLink() {
  if (!shareLink.value) {
    return;
  }

  try {
    await navigator.clipboard.writeText(shareLink.value);
    setComposerStatus((currentText) => currentText.composer.copied, "success");
  } catch {
    setComposerStatus((currentText) => currentText.composer.copyFailed, "warning");
  }
}

function downloadBlobFile(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function requestReaderPrivateKey() {
  readerPrivateKeyPrompt.visible = true;
  readerPrivateKeyPrompt.selectedFileName = "";
  setReaderPrivateKeyPromptError("");

  return new Promise((resolve, reject) => {
    pendingPrivateKeyRequest = { resolve, reject };
  });
}

function openReaderPrivateKeyPicker() {
  if (!readerPrivateKeyInput.value) {
    return;
  }

  readerPrivateKeyInput.value.value = "";
  readerPrivateKeyInput.value.click();
}

function cancelReaderPrivateKeyPrompt(silent = false) {
  readerPrivateKeyPrompt.visible = false;
  readerPrivateKeyPrompt.selectedFileName = "";
  setReaderPrivateKeyPromptError("");

  if (!pendingPrivateKeyRequest) {
    return;
  }

  const { reject } = pendingPrivateKeyRequest;
  pendingPrivateKeyRequest = null;
  if (!silent) {
    reject(createLocalizedError((currentText) => currentText.reader.errors.privateKeyRequired));
  }
}

async function onReaderPrivateKeySelected(event) {
  const file = event.target.files?.[0];
  if (!file || !pendingPrivateKeyRequest) {
    return;
  }

  try {
    const privateKey = await importX25519PrivateKey(await file.arrayBuffer());
    const { resolve } = pendingPrivateKeyRequest;
    pendingPrivateKeyRequest = null;
    readerPrivateKeyPrompt.visible = false;
    readerPrivateKeyPrompt.selectedFileName = file.name;
    setReaderPrivateKeyPromptError("");
    resolve(privateKey);
  } catch {
    setReaderPrivateKeyPromptError((currentText) => currentText.reader.errors.invalidPrivateKey);
  }
}

async function previewAttachment(attachment) {
  clearPreview();
  const previewKind = getPreviewKind(attachment);
  if (previewKind === "download") {
    downloadAttachment(attachment);
    return;
  }

  if (previewKind === "text") {
    preview.name = attachment.name;
    preview.sourceText = await attachment.blob.text();
    preview.kind = "text";
    preview.visible = true;
    return;
  }

  preview.name = attachment.name;
  preview.activeUrl = URL.createObjectURL(attachment.blob);
  preview.kind = previewKind;
  preview.visible = true;
}

function downloadAttachment(attachment) {
  downloadBlobFile(attachment.blob, attachment.name);
}

function clearPreview() {
  closeExpandedPreview();

  if (preview.activeUrl) {
    URL.revokeObjectURL(preview.activeUrl);
    preview.activeUrl = "";
  }

  preview.kind = "";
  preview.name = "";
  preview.sourceText = "";
  preview.visible = false;
}
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <div class="mx-auto max-w-5xl px-4 py-7 pb-10 sm:px-6">
      <!-- Header -->
      <header class="mb-6 flex flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:justify-between">
        <a
          href="/"
          class="text-xl font-bold tracking-wider text-primary no-underline transition-colors hover:text-primary/80"
        >
          {{ text.appName }}
        </a>

        <div class="flex items-center gap-2">
          <ThemeToggle :is-dark="isDark" @toggle="toggleTheme" />

          <div
            class="inline-flex gap-1 rounded-full border border-border bg-secondary/50 p-1.5"
            role="group"
            aria-label="language"
          >
            <button
              v-for="option in ['zh', 'en']"
              :key="option"
              :class="[
                'cursor-pointer rounded-full border-none px-3.5 py-1.5 text-sm font-medium transition-colors',
                locale === option
                  ? 'bg-primary/15 text-primary'
                  : 'bg-transparent text-muted-foreground hover:text-foreground'
              ]"
              type="button"
              @click="switchLocale(option)"
            >
              {{ text.localeOptions[option] }}
            </button>
          </div>
        </div>
      </header>

      <!-- Policy View -->
      <section v-if="policyMode" class="mx-auto max-w-3xl">
        <div class="space-y-6 rounded-2xl border border-border bg-card p-7 shadow-lg">
          <div>
            <h1 class="text-3xl font-bold text-card-foreground">{{ text.policy.title }}</h1>
            <p class="mt-3 leading-relaxed text-muted-foreground">{{ text.policy.intro }}</p>
          </div>

          <section
            v-for="section in text.policy.sections"
            :key="section.title"
            class="space-y-4 rounded-xl border border-border bg-muted/30 p-6"
          >
            <h2 class="text-lg font-semibold text-card-foreground">{{ section.title }}</h2>
            <ul class="list-disc space-y-2.5 pl-5 leading-relaxed text-muted-foreground">
              <li v-for="item in section.items" :key="item">{{ item }}</li>
            </ul>
          </section>
        </div>
      </section>

      <!-- Reader View -->
      <section v-else-if="readerMode" class="grid gap-5 lg:grid-cols-[1.35fr_0.75fr]">
        <!-- Left: reader card -->
        <div class="space-y-5 rounded-2xl border border-border bg-card p-7 shadow-lg">
          <h1 class="text-3xl font-bold text-card-foreground">{{ text.reader.title }}</h1>

          <!-- Status banner -->
          <div
            :class="[toneClasses(reader.statusTone), 'rounded-xl border px-4 py-3.5 text-sm font-semibold']"
          >
            {{ readerStatusMessage }}
          </div>

          <!-- Message body -->
          <div class="space-y-4 rounded-xl border border-border bg-muted/30 p-5">
            <h2 class="text-base font-semibold text-card-foreground">{{ text.reader.bodyTitle }}</h2>
            <pre class="min-h-[180px] whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-4 font-mono text-sm leading-relaxed text-foreground">{{ readerMessage }}</pre>
          </div>

          <!-- Attachments -->
          <div class="space-y-4 rounded-xl border border-border bg-muted/30 p-5">
            <div class="flex items-center justify-between gap-4">
              <h2 class="text-base font-semibold text-card-foreground">{{ text.reader.attachmentsTitle }}</h2>
              <span class="text-sm text-muted-foreground">{{ readerSummary }}</span>
            </div>

            <div v-if="reader.attachments.length" class="space-y-3">
              <div
                v-for="attachment in reader.attachments"
                :key="`${attachment.index}-${attachment.name}`"
                class="flex flex-col items-stretch gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div>
                  <p class="font-semibold text-foreground">{{ attachment.name }}</p>
                  <p class="text-sm text-muted-foreground">
                    {{ attachment.type || text.common.attachmentTypeFallback }} &middot; {{ formatBytes(attachment.size) }}
                  </p>
                </div>
                <div class="flex flex-wrap gap-2.5">
                  <Button
                    v-if="getPreviewKind(attachment) !== 'download'"
                    variant="secondary"
                    size="sm"
                    type="button"
                    @click="previewAttachment(attachment)"
                  >
                    {{ text.common.preview }}
                  </Button>
                  <Button variant="secondary" size="sm" type="button" @click="downloadAttachment(attachment)">
                    {{ text.common.download }}
                  </Button>
                </div>
              </div>
            </div>
            <p v-else class="text-muted-foreground">{{ text.reader.noAttachments }}</p>
          </div>
        </div>

        <!-- Right: preview card -->
        <div class="space-y-5 rounded-2xl border border-border bg-card p-7 shadow-lg">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <h1 class="text-xl font-bold text-card-foreground">{{ text.reader.previewTitle }}</h1>
              <p v-if="preview.visible && preview.name" class="mt-1 truncate text-sm text-muted-foreground">
                {{ preview.name }}
              </p>
            </div>
            <Button
              v-if="hasExpandablePreview"
              variant="secondary"
              size="sm"
              type="button"
              @click="openExpandedPreview"
            >
              {{ text.reader.expandPreview }}
            </Button>
          </div>

          <div
            v-if="!preview.visible"
            class="grid min-h-[520px] place-items-center rounded-xl border border-border bg-muted/30 text-muted-foreground"
          >
            {{ previewPlaceholder }}
          </div>
          <div
            v-else-if="preview.kind === 'text'"
            class="grid min-h-[520px] place-items-start overflow-auto rounded-xl border border-border p-4"
          >
            <pre class="m-0 w-full min-h-full whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground">{{ previewTextContent }}</pre>
          </div>
          <button
            v-else-if="preview.kind === 'image'"
            class="grid min-h-[520px] w-full cursor-zoom-in place-items-center overflow-auto rounded-xl border border-border bg-muted/20 p-4"
            :title="text.reader.expandPreview"
            type="button"
            @click="openExpandedPreview"
          >
            <img class="block max-h-[480px] max-w-full rounded border-0 bg-muted" :src="preview.activeUrl" alt="attachment preview">
          </button>
          <div
            v-else-if="preview.kind === 'video'"
            class="grid min-h-[520px] place-items-center overflow-auto rounded-xl border border-border bg-muted/20 p-4"
          >
            <video class="block max-h-[480px] max-w-full rounded border-0 bg-muted" :src="preview.activeUrl" controls playsinline></video>
          </div>
          <iframe
            v-else-if="preview.kind === 'pdf'"
            class="min-h-[520px] w-full rounded-xl border border-border bg-muted/20"
            :src="preview.activeUrl"
            title="attachment preview"
            sandbox="allow-downloads allow-same-origin"
          ></iframe>
        </div>
      </section>

      <!-- Composer View -->
      <section v-else class="mx-auto max-w-3xl">
        <div class="space-y-5 rounded-2xl border border-border bg-card p-7 shadow-lg">
          <h1 class="text-3xl font-bold text-card-foreground">{{ text.composer.title }}</h1>

          <form class="space-y-5" @submit.prevent="createMessage">
            <!-- Message body -->
            <div class="space-y-2.5">
              <label class="text-sm font-semibold text-foreground">{{ text.composer.bodyLabel }}</label>
              <textarea
                v-model="composer.message"
                rows="8"
                maxlength="100000"
                :placeholder="text.composer.bodyPlaceholder"
                class="min-h-[190px] w-full resize-y rounded-lg border border-input bg-transparent px-4 py-3.5 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              ></textarea>
            </div>

            <!-- Field grid -->
            <div class="grid gap-4 lg:grid-cols-[1.2fr_0.7fr_0.7fr]">
              <!-- File picker -->
              <div class="space-y-2.5">
                <label class="text-sm font-semibold text-foreground">{{ text.composer.attachmentsLabel }}</label>
                <div class="flex min-h-[76px] items-center gap-3.5 rounded-xl border border-input bg-muted/30 p-4">
                  <input
                    ref="fileInput"
                    class="hidden"
                    type="file"
                    multiple
                    accept=".jpg,.jpeg,.png,.webp,.gif,.mp4,.webm,.mov,.txt,.pdf,image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,text/plain,application/pdf"
                    @change="onFileChange"
                  >
                  <Button variant="outline" type="button" @click="openFilePicker">
                    {{ text.composer.chooseFiles }}
                  </Button>
                  <p class="m-0 text-sm leading-relaxed text-muted-foreground">{{ selectedFileSummary }}</p>
                </div>
              </div>

              <!-- TTL select -->
              <div class="space-y-2.5">
                <label class="text-sm font-semibold text-foreground">{{ text.composer.expiresLabel }}</label>
                <select
                  v-model="composer.ttlSeconds"
                  class="h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option
                    v-for="option in ttlOptions"
                    :key="option.value"
                    :value="option.value"
                    class="bg-card text-card-foreground"
                  >
                    {{ option.label }}
                  </option>
                </select>
              </div>

              <!-- Max reads -->
              <div class="space-y-2.5">
                <label class="text-sm font-semibold text-foreground">{{ text.composer.maxReadsLabel }}</label>
                <input
                  v-model.number="composer.maxReads"
                  type="number"
                  min="1"
                  :max="MAX_READ_LIMIT"
                  step="1"
                  inputmode="numeric"
                  class="h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  @blur="normalizeMaxReads"
                >
              </div>
            </div>

            <!-- Enhanced encryption -->
            <div class="space-y-4 rounded-xl border border-border bg-muted/30 p-4">
              <label class="flex cursor-pointer items-start gap-3">
                <input
                  :checked="isEnhancedEncryptionEnabled"
                  type="checkbox"
                  class="mt-1 h-4 w-4 rounded border-input text-primary focus:ring-ring"
                  @change="composer.encryptionMode = $event.target.checked ? ENCRYPTION_MODE_ENHANCED : ENCRYPTION_MODE_STANDARD"
                >
                <div class="space-y-1">
                  <p class="m-0 text-sm font-semibold text-foreground">{{ text.composer.enhanced.toggleLabel }}</p>
                  <p class="m-0 text-sm leading-relaxed text-muted-foreground">
                    {{ text.composer.enhanced.toggleHint }}
                  </p>
                </div>
              </label>

              <div v-if="isEnhancedEncryptionEnabled" class="space-y-4">
                <div class="space-y-2 rounded-xl border border-border bg-card p-4">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p class="m-0 text-sm font-semibold text-foreground">{{ text.composer.enhanced.bootstrapLabel }}</p>
                      <p class="m-0 mt-1 text-sm text-muted-foreground">{{ enhancedBootstrapMessage }}</p>
                    </div>
                    <Button
                      v-if="enhancedBootstrap.status === 'error'"
                      variant="secondary"
                      size="sm"
                      type="button"
                      @click="regenerateEnhancedBootstrap"
                    >
                      {{ text.composer.enhanced.retryBootstrap }}
                    </Button>
                  </div>
                  <div class="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      class="h-full rounded-full bg-primary transition-all"
                      :style="{ width: `${enhancedBootstrapProgressPercent}%` }"
                    ></div>
                  </div>
                </div>

                <div v-if="enhancedBootstrapReady" class="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
                  <div class="space-y-3 rounded-xl border border-border bg-card p-4">
                    <div>
                      <p class="m-0 text-sm font-semibold text-foreground">{{ text.composer.enhanced.generateTitle }}</p>
                      <p class="m-0 mt-1 text-sm leading-relaxed text-muted-foreground">
                        {{ text.composer.enhanced.generateHint }}
                      </p>
                    </div>
                    <Button type="button" @click="generateEnhancedKeyPairAndDownload">
                      {{ text.composer.enhanced.generateButton }}
                    </Button>
                    <p v-if="enhancedBootstrap.privateKeyFileName" class="m-0 text-sm text-muted-foreground">
                      {{ text.composer.enhanced.privateKeyDownloaded(enhancedBootstrap.privateKeyFileName) }}
                    </p>
                  </div>

                  <div class="space-y-3 rounded-xl border border-border bg-card p-4">
                    <div class="space-y-2">
                      <div class="flex items-center justify-between gap-3">
                        <label class="text-sm font-semibold text-foreground">
                          {{ text.composer.enhanced.publicKeyLabel }}
                        </label>
                        <Button
                          variant="secondary"
                          size="sm"
                          type="button"
                          :disabled="!enhancedBootstrap.generatedPublicKey"
                          @click="copyGeneratedPublicKey"
                        >
                          {{ text.composer.enhanced.copyPublicKey }}
                        </Button>
                      </div>
                      <textarea
                        :value="enhancedBootstrap.generatedPublicKey"
                        rows="3"
                        readonly
                        :placeholder="text.composer.enhanced.publicKeyPlaceholder"
                        class="w-full resize-y rounded-lg border border-input bg-transparent px-4 py-3 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      ></textarea>
                    </div>

                    <div class="space-y-2">
                      <label class="text-sm font-semibold text-foreground">
                        {{ text.composer.enhanced.recipientPublicKeyLabel }}
                      </label>
                      <textarea
                        v-model="composer.recipientPublicKey"
                        rows="4"
                        :placeholder="text.composer.enhanced.recipientPublicKeyPlaceholder"
                        class="w-full resize-y rounded-lg border border-input bg-transparent px-4 py-3 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      ></textarea>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Attachment summary -->
            <div class="space-y-1 rounded-xl border border-border bg-muted/30 p-4">
              <span class="text-sm font-semibold text-foreground">{{ text.composer.summaryLabel }}</span>
              <p class="m-0 font-medium text-foreground">{{ selectedFileSummary }}</p>
            </div>

            <!-- Status banner -->
            <div
              :class="[toneClasses(composerStatus.tone), 'rounded-xl border px-4 py-3.5 text-sm font-semibold']"
            >
              {{ composerStatusMessage }}
            </div>

            <!-- Submit -->
            <Button type="submit" :disabled="isCreating" class="w-full">
              {{ isCreating ? text.composer.creating : text.composer.create }}
            </Button>
          </form>

          <!-- Share link -->
          <transition name="fade-up">
            <div v-if="shareLink" class="space-y-4 rounded-xl border border-border bg-muted/30 p-5">
              <div class="flex items-center justify-between gap-4">
                <h2 class="text-base font-semibold text-card-foreground">{{ text.composer.shareTitle }}</h2>
                <Button variant="secondary" size="sm" type="button" @click="copyShareLink">
                  {{ text.composer.copyLink }}
                </Button>
              </div>
              <input
                type="text"
                :value="shareLink"
                readonly
                aria-label="share-link"
                class="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
            </div>
          </transition>
        </div>
      </section>

      <teleport to="body">
        <transition name="fade-up">
          <div
            v-if="isPreviewExpanded"
            class="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            @click.self="closeExpandedPreview"
          >
            <div class="flex h-full flex-col p-4 sm:p-6">
              <div class="mb-4 flex items-center justify-between gap-4 rounded-2xl border border-border bg-card/95 px-4 py-3 shadow-xl">
                <div class="min-w-0">
                  <h2 class="truncate text-base font-semibold text-card-foreground">{{ previewDialogTitle }}</h2>
                  <p class="text-sm text-muted-foreground">{{ text.reader.previewTitle }}</p>
                </div>
                <Button variant="secondary" size="sm" type="button" @click="closeExpandedPreview">
                  {{ text.reader.closeExpandedPreview }}
                </Button>
              </div>

              <div class="min-h-0 flex-1 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
                <div
                  v-if="preview.kind === 'text'"
                  class="h-full overflow-auto p-5 sm:p-6"
                >
                  <pre class="m-0 w-full whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground">{{ previewTextContent }}</pre>
                </div>
                <div
                  v-else-if="preview.kind === 'image'"
                  class="grid h-full place-items-center overflow-auto bg-muted/20 p-5 sm:p-6"
                >
                  <img class="block max-h-full max-w-full rounded-lg border-0 bg-muted" :src="preview.activeUrl" alt="attachment preview">
                </div>
                <div
                  v-else-if="preview.kind === 'video'"
                  class="grid h-full place-items-center overflow-auto bg-muted/20 p-5 sm:p-6"
                >
                  <video class="block max-h-full max-w-full rounded-lg border-0 bg-muted" :src="preview.activeUrl" controls playsinline></video>
                </div>
                <iframe
                  v-else-if="preview.kind === 'pdf'"
                  class="h-full w-full border-0 bg-muted/20"
                  :src="preview.activeUrl"
                  title="attachment preview expanded"
                  sandbox="allow-downloads allow-same-origin"
                ></iframe>
              </div>
            </div>
          </div>
        </transition>
      </teleport>

      <teleport to="body">
        <transition name="fade-up">
          <div
            v-if="readerPrivateKeyPrompt.visible"
            class="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            @click.self="cancelReaderPrivateKeyPrompt"
          >
            <div class="flex h-full items-center justify-center p-4 sm:p-6">
              <div class="w-full max-w-lg space-y-4 rounded-2xl border border-border bg-card p-6 shadow-2xl">
                <input
                  ref="readerPrivateKeyInput"
                  class="hidden"
                  type="file"
                  accept=".pk8,application/pkcs8,.der,application/octet-stream"
                  @change="onReaderPrivateKeySelected"
                >
                <div class="space-y-2">
                  <h2 class="text-lg font-semibold text-card-foreground">{{ text.reader.privateKeyPromptTitle }}</h2>
                  <p class="text-sm leading-relaxed text-muted-foreground">
                    {{ text.reader.privateKeyPromptBody }}
                  </p>
                </div>

                <div
                  v-if="readerPrivateKeyPromptError"
                  :class="[toneClasses('error'), 'rounded-xl border px-4 py-3 text-sm font-semibold']"
                >
                  {{ readerPrivateKeyPromptError }}
                </div>

                <p v-if="readerPrivateKeyPrompt.selectedFileName" class="text-sm text-muted-foreground">
                  {{ text.reader.privateKeySelected(readerPrivateKeyPrompt.selectedFileName) }}
                </p>

                <div class="flex flex-wrap justify-end gap-2">
                  <Button variant="secondary" type="button" @click="cancelReaderPrivateKeyPrompt">
                    {{ text.reader.privateKeyPromptCancel }}
                  </Button>
                  <Button type="button" @click="openReaderPrivateKeyPicker">
                    {{ text.reader.privateKeyPromptChoose }}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </transition>
      </teleport>

      <!-- Footer -->
      <footer class="mt-6 flex justify-center">
        <a
          :href="footerHref"
          class="rounded-full border border-border bg-secondary/50 px-4 py-2.5 text-sm font-medium text-muted-foreground no-underline transition-colors hover:bg-accent hover:text-foreground"
        >
          {{ footerLabel }}
        </a>
      </footer>
    </div>
  </div>
</template>

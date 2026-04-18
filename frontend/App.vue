<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import { getPreviewKind } from "../src/shared.js";
import {
  DEFAULT_READ_LIMIT,
  MAX_READ_LIMIT,
  MAX_TOTAL_SIZE_BYTES,
  base64UrlDecode,
  clampReadLimit,
  decryptToString,
  deriveAesKey,
  encryptAttachment,
  encryptPayload,
  formatBytes,
  generateOpaqueId,
  readMessageIdFromPath,
  safeReadJson,
  validateDraft
} from "./lib/privmsg.js";
import { detectInitialLocale, messages, persistLocale } from "./i18n.js";

const policyMode = window.location.pathname === "/policy" || window.location.pathname === "/policy/";
const readerMode = window.location.pathname.startsWith("/m/");

const locale = ref(detectInitialLocale());
const text = computed(() => messages[locale.value] || messages.zh);
const ttlOptions = computed(() => text.value.ttlOptions);

const composer = reactive({
  message: "",
  files: [],
  ttlSeconds: 86400,
  maxReads: DEFAULT_READ_LIMIT
});

const composerStatus = reactive({
  message: "",
  tone: "progress"
});

const shareLink = ref("");
const isCreating = ref(false);
const fileInput = ref(null);

const reader = reactive({
  statusMessage: "",
  statusTone: "progress",
  loaded: false,
  message: "",
  attachments: []
});

const preview = reactive({
  activeUrl: "",
  kind: "",
  textContent: "",
  visible: false
});

const selectedTotalSize = computed(() => composer.files.reduce((sum, file) => sum + file.size, 0));
const selectedFileSummary = computed(() => {
  if (!composer.files.length) {
    return text.value.composer.noFiles;
  }

  return text.value.composer.selectedFiles(composer.files.length, formatBytes(selectedTotalSize.value));
});
const previewPlaceholder = computed(() => text.value.reader.previewPlaceholder);
const readerSummary = computed(() =>
  reader.attachments.length ? text.value.reader.summary(reader.attachments.length) : text.value.reader.noAttachments
);
const readerMessage = computed(() => {
  if (!reader.loaded) {
    return text.value.reader.waitingBody;
  }

  return reader.message || text.value.reader.emptyBody;
});
const footerHref = computed(() => (policyMode ? "/" : "/policy"));
const footerLabel = computed(() => (policyMode ? text.value.footer.home : text.value.footer.legal));

watch(
  locale,
  () => {
    persistLocale(locale.value);
    document.documentElement.lang = locale.value === "zh" ? "zh-CN" : "en";

    if (!readerMode && !policyMode && !isCreating.value && !shareLink.value) {
      setComposerStatus(text.value.composer.initialStatus, "progress");
    }

    if (readerMode && !reader.loaded) {
      setReaderStatus(text.value.reader.initialStatus, "progress");
    }
  },
  { immediate: true }
);

onMounted(() => {
  if (readerMode) {
    void loadMessage();
  }
});

onBeforeUnmount(() => {
  clearPreview();
});

function setComposerStatus(message, tone = "progress") {
  composerStatus.message = message;
  composerStatus.tone = tone;
}

function setReaderStatus(message, tone = "progress") {
  reader.statusMessage = message;
  reader.statusTone = tone;
}

function switchLocale(nextLocale) {
  locale.value = nextLocale;
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

async function createMessage() {
  const validationError = validateDraft(composer.message, composer.files, text.value.composer.validation);
  if (validationError) {
    setComposerStatus(validationError, "error");
    return;
  }

  isCreating.value = true;
  shareLink.value = "";

  try {
    const messageId = generateOpaqueId();
    const masterKeyBytes = crypto.getRandomValues(new Uint8Array(32));
    const maxReads = clampReadLimit(composer.maxReads);
    const masterKey = btoa(String.fromCharCode(...masterKeyBytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");

    setComposerStatus(text.value.composer.encryptMessage);

    const encryptedAttachments = [];
    let totalSize = 0;

    for (let index = 0; index < composer.files.length; index += 1) {
      const file = composer.files[index];
      totalSize += file.size;
      setComposerStatus(text.value.composer.encryptAttachment(index, composer.files.length, file.name));
      encryptedAttachments.push(await encryptAttachment(file, index, masterKeyBytes, messageId));
    }

    const payload = await encryptPayload(
      {
        version: 1,
        message: composer.message,
        attachments: encryptedAttachments.map(({ meta }) => meta)
      },
      masterKeyBytes,
      messageId
    );

    const metadata = {
      id: messageId,
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

    setComposerStatus(text.value.composer.uploading);

    const response = await fetch("/api/create", {
      method: "POST",
      body: formData
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.message || "Create failed");
    }

    shareLink.value = `${window.location.origin}/m/${messageId}#${masterKey}`;
    setComposerStatus(text.value.composer.created(maxReads), "success");
  } catch (error) {
    setComposerStatus(error.message || "Create failed", "error");
  } finally {
    isCreating.value = false;
  }
}

async function loadMessage() {
  try {
    reader.loaded = false;
    const messageId = readMessageIdFromPath();
    const masterKey = window.location.hash.slice(1);

    if (!messageId) {
      throw new Error("Missing message id");
    }

    if (!masterKey) {
      throw new Error("Missing decryption key");
    }

    setReaderStatus(text.value.reader.fetching);

    const messageResponse = await fetch(`/api/message/${messageId}`, {
      headers: {
        Accept: "application/json"
      }
    });

    const envelope = await messageResponse.json();
    if (!messageResponse.ok) {
      throw new Error(envelope.message || "Read failed");
    }

    setReaderStatus(text.value.reader.decryptingMessage);

    const masterKeyBytes = base64UrlDecode(masterKey);
    const payloadKey = await deriveAesKey(masterKeyBytes, messageId, "payload", ["decrypt"]);
    const payloadPlaintext = await decryptToString(envelope.payload.ciphertext, envelope.payload.iv, payloadKey);
    const payload = JSON.parse(payloadPlaintext);
    const attachmentEnvelopes = new Map((envelope.attachments || []).map((item) => [item.index, item]));

    const decryptedAttachments = [];
    for (const attachment of payload.attachments || []) {
      const attachmentEnvelope = attachmentEnvelopes.get(attachment.index);
      if (!attachmentEnvelope) {
        throw new Error(`Missing encrypted envelope for attachment ${attachment.index}`);
      }

      setReaderStatus(text.value.reader.decryptingAttachment(attachment.name));

      const fileResponse = await fetch(`/api/message/${messageId}/file/${attachment.index}`);
      if (!fileResponse.ok) {
        const errorBody = await safeReadJson(fileResponse);
        throw new Error(errorBody.message || `Unable to fetch attachment ${attachment.name}`);
      }

      const encryptedBytes = await fileResponse.arrayBuffer();
      const attachmentKey = await deriveAesKey(masterKeyBytes, messageId, `file:${attachment.index}`, ["decrypt"]);
      const decryptedBuffer = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64UrlDecode(attachmentEnvelope.iv)
        },
        attachmentKey,
        encryptedBytes
      );

      decryptedAttachments.push({
        ...attachment,
        blob: new Blob([decryptedBuffer], {
          type: attachment.type || text.value.common.attachmentTypeFallback
        })
      });
    }

    setReaderStatus(text.value.reader.confirming);

    const confirmResponse = await fetch("/api/confirm-read", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ id: messageId })
    });

    const confirmResult = await safeReadJson(confirmResponse);
    if (!confirmResponse.ok) {
      setReaderStatus(confirmResult.message || "Confirm failed", "warning");
    } else if (confirmResult.burned) {
      setReaderStatus(text.value.reader.burned, "success");
    } else {
      setReaderStatus(text.value.reader.remaining(confirmResult.remainingReads), "success");
    }

    reader.message = payload.message || "";
    reader.attachments = decryptedAttachments;
    reader.loaded = true;
  } catch (error) {
    reader.message = text.value.reader.unavailable;
    reader.attachments = [];
    reader.loaded = true;
    setReaderStatus(error.message || "Decrypt failed", "error");
  }
}

async function copyShareLink() {
  if (!shareLink.value) {
    return;
  }

  try {
    await navigator.clipboard.writeText(shareLink.value);
    setComposerStatus(text.value.composer.copied, "success");
  } catch {
    setComposerStatus(text.value.composer.copyFailed, "warning");
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
    const textContent = await attachment.blob.text();
    preview.kind = "text";
    preview.textContent =
      textContent.length > 200000
        ? `${textContent.slice(0, 200000)}\n\n[Preview truncated. Download to see the full file.]`
        : textContent;
    preview.visible = true;
    return;
  }

  preview.activeUrl = URL.createObjectURL(attachment.blob);
  preview.kind = previewKind;
  preview.visible = true;
  if (previewKind === "image") {
    return;
  }

  if (previewKind === "video") {
    return;
  }

  if (previewKind === "pdf") {
    return;
  }
}

function downloadAttachment(attachment) {
  const url = URL.createObjectURL(attachment.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = attachment.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearPreview() {
  if (preview.activeUrl) {
    URL.revokeObjectURL(preview.activeUrl);
    preview.activeUrl = "";
  }

  preview.kind = "";
  preview.textContent = "";
  preview.visible = false;
}
</script>

<template>
  <main class="page-shell">
    <div class="ambient ambient-primary"></div>
    <div class="ambient ambient-secondary"></div>

    <header class="topbar">
      <a class="brand" href="/">{{ text.appName }}</a>

      <div class="locale-switch" role="group" aria-label="language">
        <button
          v-for="option in ['zh', 'en']"
          :key="option"
          class="locale-button"
          :class="{ active: locale === option }"
          type="button"
          @click="switchLocale(option)"
        >
          {{ text.localeOptions[option] }}
        </button>
      </div>
    </header>

    <section v-if="policyMode" class="workspace-single">
      <article class="workspace-card policy-card">
        <div class="section-head">
          <h1>{{ text.policy.title }}</h1>
          <p class="section-copy">{{ text.policy.intro }}</p>
        </div>

        <section v-for="section in text.policy.sections" :key="section.title" class="policy-section">
          <h2>{{ section.title }}</h2>
          <ul class="notice-list">
            <li v-for="item in section.items" :key="item">{{ item }}</li>
          </ul>
        </section>
      </article>
    </section>

    <section v-else-if="readerMode" class="reader-grid">
      <article class="workspace-card reader-card">
        <div class="section-head">
          <h1>{{ text.reader.title }}</h1>
        </div>

        <div class="status-banner" :class="`tone-${reader.statusTone}`">
          {{ reader.statusMessage }}
        </div>

        <section class="panel-card">
          <h2>{{ text.reader.bodyTitle }}</h2>
          <pre class="message-output">{{ readerMessage }}</pre>
        </section>

        <section class="panel-card">
          <div class="panel-head">
            <h2>{{ text.reader.attachmentsTitle }}</h2>
            <span class="panel-meta">{{ readerSummary }}</span>
          </div>

          <div v-if="reader.attachments.length" class="attachment-list">
            <article v-for="attachment in reader.attachments" :key="`${attachment.index}-${attachment.name}`" class="attachment-card">
              <div>
                <p class="attachment-title">{{ attachment.name }}</p>
                <p class="attachment-meta">
                  {{ attachment.type || text.common.attachmentTypeFallback }} · {{ formatBytes(attachment.size) }}
                </p>
              </div>

              <div class="attachment-actions">
                <button
                  v-if="getPreviewKind(attachment) !== 'download'"
                  class="secondary-button"
                  type="button"
                  @click="previewAttachment(attachment)"
                >
                  {{ text.common.preview }}
                </button>
                <button class="secondary-button" type="button" @click="downloadAttachment(attachment)">
                  {{ text.common.download }}
                </button>
              </div>
            </article>
          </div>
          <p v-else class="muted">{{ text.reader.noAttachments }}</p>
        </section>
      </article>

      <article class="workspace-card preview-card">
        <div class="section-head">
          <h1>{{ text.reader.previewTitle }}</h1>
        </div>

        <div v-if="!preview.visible" class="preview-placeholder">
          {{ previewPlaceholder }}
        </div>
        <div v-else-if="preview.kind === 'text'" class="preview-surface">
          <pre class="preview-text">{{ preview.textContent }}</pre>
        </div>
        <div v-else-if="preview.kind === 'image'" class="preview-surface">
          <img class="preview-media" :src="preview.activeUrl" alt="attachment preview">
        </div>
        <div v-else-if="preview.kind === 'video'" class="preview-surface">
          <video class="preview-media" :src="preview.activeUrl" controls playsinline></video>
        </div>
        <iframe
          v-else-if="preview.kind === 'pdf'"
          class="preview-frame"
          :src="preview.activeUrl"
          title="attachment preview"
          sandbox="allow-downloads allow-same-origin"
        ></iframe>
      </article>
    </section>

    <section v-else class="workspace-single">
      <article class="workspace-card composer-card">
        <div class="section-head">
          <h1>{{ text.composer.title }}</h1>
        </div>

        <form class="composer-form" @submit.prevent="createMessage">
          <label class="field">
            <span>{{ text.composer.bodyLabel }}</span>
            <textarea
              v-model="composer.message"
              rows="8"
              maxlength="100000"
              :placeholder="text.composer.bodyPlaceholder"
            ></textarea>
          </label>

          <div class="field-grid">
            <label class="field">
              <span>{{ text.composer.attachmentsLabel }}</span>
              <div class="file-picker">
                <input
                  ref="fileInput"
                  class="file-input"
                  type="file"
                  multiple
                  accept=".jpg,.jpeg,.png,.webp,.gif,.mp4,.webm,.mov,.txt,.pdf,image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,text/plain,application/pdf"
                  @change="onFileChange"
                >
                <button class="file-picker-button" type="button" @click="openFilePicker">
                  {{ text.composer.chooseFiles }}
                </button>
                <p class="file-picker-text">{{ selectedFileSummary }}</p>
              </div>
            </label>

            <label class="field">
              <span>{{ text.composer.expiresLabel }}</span>
              <select v-model="composer.ttlSeconds">
                <option v-for="option in ttlOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </label>

            <label class="field">
              <span>{{ text.composer.maxReadsLabel }}</span>
              <input
                v-model.number="composer.maxReads"
                type="number"
                min="1"
                :max="MAX_READ_LIMIT"
                step="1"
                inputmode="numeric"
                @blur="normalizeMaxReads"
              >
            </label>
          </div>

          <div class="summary-card">
            <span>{{ text.composer.summaryLabel }}</span>
            <strong>{{ selectedFileSummary }}</strong>
          </div>

          <div class="status-banner" :class="`tone-${composerStatus.tone}`">
            {{ composerStatus.message }}
          </div>

          <button class="primary-button" type="submit" :disabled="isCreating">
            {{ isCreating ? text.composer.creating : text.composer.create }}
          </button>
        </form>

        <transition name="fade-up">
          <section v-if="shareLink" class="share-card">
            <div class="panel-head">
              <h2>{{ text.composer.shareTitle }}</h2>
              <button class="secondary-button" type="button" @click="copyShareLink">
                {{ text.composer.copyLink }}
              </button>
            </div>
            <input class="share-input" type="text" :value="shareLink" readonly aria-label="share-link">
          </section>
        </transition>
      </article>
    </section>

    <footer class="page-footer">
      <a class="footer-link" :href="footerHref">{{ footerLabel }}</a>
    </footer>
  </main>
</template>

<style>
.page-shell {
  position: relative;
  width: min(1180px, calc(100% - 32px));
  margin: 0 auto;
  padding: 28px 0 40px;
  color: #f4dde8;
}

.ambient {
  position: fixed;
  border-radius: 999px;
  filter: blur(44px);
  pointer-events: none;
  opacity: 0.28;
}

.ambient-primary {
  width: 26rem;
  height: 26rem;
  top: -6rem;
  left: -8rem;
  background: rgba(187, 79, 131, 0.55);
}

.ambient-secondary {
  width: 24rem;
  height: 24rem;
  right: -6rem;
  bottom: 10rem;
  background: rgba(110, 57, 127, 0.42);
}

.topbar,
.panel-head,
.attachment-card,
.page-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.topbar {
  margin-bottom: 20px;
}

.brand {
  color: #ffe1ec;
  text-decoration: none;
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.locale-switch {
  display: inline-flex;
  gap: 8px;
  padding: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 189, 220, 0.14);
}

.locale-button,
.primary-button,
.secondary-button,
.footer-link,
.file-picker-button {
  border: none;
  border-radius: 999px;
  font: inherit;
  text-decoration: none;
  cursor: pointer;
  transition:
    transform 150ms ease,
    opacity 150ms ease,
    background-color 150ms ease;
}

.locale-button {
  padding: 8px 14px;
  background: transparent;
  color: #e8c6d5;
}

.locale-button.active {
  background: rgba(255, 153, 204, 0.16);
  color: #fff0f7;
}

.workspace-single,
.reader-grid {
  display: grid;
  gap: 20px;
}

.reader-grid {
  grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.75fr);
}

.workspace-card {
  position: relative;
  overflow: hidden;
  padding: 28px;
  border-radius: 28px;
  border: 1px solid rgba(255, 190, 223, 0.10);
  background:
    linear-gradient(180deg, rgba(28, 21, 31, 0.96) 0%, rgba(18, 14, 21, 0.94) 100%);
  box-shadow: 0 22px 70px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.workspace-card::after {
  content: "";
  position: absolute;
  inset: auto -10% -36% auto;
  width: 18rem;
  height: 18rem;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(177, 67, 117, 0.18) 0%, rgba(177, 67, 117, 0) 72%);
  pointer-events: none;
}

.policy-card {
  display: grid;
  gap: 26px;
}

.section-head,
.composer-form,
.share-card,
.panel-card,
.policy-section {
  display: grid;
  gap: 18px;
}

.section-head h1,
.panel-card h2,
.policy-section h2 {
  margin: 0;
  color: #fff2f8;
  font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
  line-height: 1.02;
}

.section-head h1 {
  font-size: clamp(2rem, 4vw, 3.1rem);
}

.section-copy,
.muted,
.attachment-meta,
.notice-list,
.panel-meta {
  margin: 0;
  color: #bfa4b1;
  line-height: 1.7;
}

.composer-form {
  margin-top: 10px;
}

.field-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) repeat(2, minmax(180px, 0.7fr));
  gap: 16px;
}

.field {
  display: grid;
  gap: 10px;
}

.field span,
.summary-card span,
.attachment-title {
  color: #f8ddea;
  font-weight: 700;
}

textarea,
input[type="number"],
select,
.share-input {
  width: 100%;
  border: 1px solid rgba(255, 190, 223, 0.12);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.04);
  color: #f8ddea;
  font: inherit;
}

textarea,
input[type="number"],
select,
.share-input {
  padding: 14px 16px;
}

textarea {
  min-height: 190px;
  resize: vertical;
}

.file-input {
  display: none;
}

.file-picker {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 76px;
  padding: 14px 16px;
  border-radius: 24px;
  border: 1px solid rgba(255, 190, 223, 0.12);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.03) 100%);
}

.file-picker-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 46px;
  padding: 0 18px;
  border: 1px solid rgba(255, 190, 223, 0.18);
  border-radius: 16px;
  color: #fff2f8;
  background:
    linear-gradient(135deg, rgba(255, 176, 214, 0.22) 0%, rgba(194, 92, 149, 0.26) 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 238, 246, 0.18),
    0 12px 24px rgba(0, 0, 0, 0.18);
}

.file-picker-text {
  margin: 0;
  color: #c9aebc;
  line-height: 1.6;
}

.summary-card,
.status-banner,
.share-card,
.panel-card,
.preview-placeholder,
.preview-frame,
.attachment-card,
.policy-section {
  border-radius: 22px;
  border: 1px solid rgba(255, 190, 223, 0.08);
  background: rgba(255, 255, 255, 0.03);
}

.summary-card,
.share-card,
.panel-card,
.policy-section {
  padding: 18px;
}

.policy-section {
  gap: 20px;
  padding: 24px;
}

.summary-card {
  display: grid;
  gap: 8px;
}

.summary-card strong {
  color: #fff3f8;
  font-size: 1rem;
}

.status-banner {
  padding: 14px 16px;
  font-weight: 600;
}

.tone-progress {
  color: #f0cadb;
  background: rgba(255, 168, 211, 0.08);
}

.tone-success {
  color: #ffd7e6;
  background: rgba(198, 93, 147, 0.14);
}

.tone-warning {
  color: #f7dcb6;
  background: rgba(182, 121, 45, 0.16);
}

.tone-error {
  color: #ffc5d8;
  background: rgba(177, 67, 117, 0.18);
}

.primary-button,
.secondary-button {
  padding: 14px 18px;
  font-weight: 700;
}

.primary-button {
  color: #160d14;
  background: linear-gradient(135deg, #ffb2d6 0%, #ea7eb3 100%);
}

.secondary-button {
  color: #ffe2ef;
  background: rgba(255, 255, 255, 0.07);
}

.primary-button:hover,
.secondary-button:hover,
.file-picker-button:hover,
.locale-button:hover,
.footer-link:hover {
  transform: translateY(-1px);
}

.primary-button:disabled {
  opacity: 0.55;
  cursor: wait;
}

.message-output {
  margin: 0;
  min-height: 180px;
  padding: 16px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.03);
  color: #fff1f7;
  white-space: pre-wrap;
  word-break: break-word;
  font: 14px/1.65 "SF Mono", Menlo, monospace;
}

.attachment-list {
  display: grid;
  gap: 12px;
}

.attachment-card {
  padding: 16px 18px;
  border-radius: 18px;
}

.attachment-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.preview-placeholder,
.preview-frame,
.preview-surface {
  width: 100%;
  min-height: 520px;
}

.preview-placeholder {
  display: grid;
  place-items: center;
  color: #cbb0be;
}

.preview-surface {
  display: grid;
  place-items: center;
  overflow: auto;
  padding: 18px;
  box-sizing: border-box;
}

.preview-text {
  margin: 0;
  width: 100%;
  min-height: 100%;
  color: #fff1f7;
  white-space: pre-wrap;
  word-break: break-word;
  font: 14px/1.65 "SF Mono", Menlo, monospace;
}

.preview-media {
  display: block;
  max-width: 100%;
  max-height: 480px;
  border: 0;
  background: #0f0c13;
}

.preview-frame {
  border: 1px solid rgba(255, 190, 223, 0.10);
  background: rgba(255, 255, 255, 0.02);
}

.notice-list {
  display: grid;
  gap: 10px;
  padding-left: 18px;
}

.page-footer {
  margin-top: 22px;
  justify-content: center;
}

.footer-link {
  padding: 12px 18px;
  color: #ffddeb;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 190, 223, 0.10);
}

.fade-up-enter-active,
.fade-up-leave-active {
  transition:
    opacity 220ms ease,
    transform 220ms ease;
}

.fade-up-enter-from,
.fade-up-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (max-width: 960px) {
  .reader-grid,
  .field-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .page-shell {
    width: min(100% - 20px, 1180px);
    padding-top: 18px;
  }

  .workspace-card {
    padding: 22px;
    border-radius: 24px;
  }

  .policy-card {
    gap: 20px;
  }

  .policy-section {
    padding: 20px;
  }

  .topbar,
  .panel-head,
  .attachment-card {
    flex-direction: column;
    align-items: stretch;
  }

  .file-picker {
    align-items: stretch;
  }

  .attachment-actions {
    justify-content: flex-start;
  }
}
</style>

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

import Button from "./components/ui/Button.vue";
import ThemeToggle from "./components/ThemeToggle.vue";

const THEME_KEY = "privmsg.theme";

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

/* ---------- theme ---------- */

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

/* ---------- lifecycle ---------- */

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

/* ---------- helpers ---------- */

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
            {{ reader.statusMessage }}
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
          <h1 class="text-xl font-bold text-card-foreground">{{ text.reader.previewTitle }}</h1>

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
            <pre class="m-0 w-full min-h-full whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground">{{ preview.textContent }}</pre>
          </div>
          <div
            v-else-if="preview.kind === 'image'"
            class="grid min-h-[520px] place-items-center overflow-auto rounded-xl border border-border p-4"
          >
            <img class="block max-h-[480px] max-w-full rounded border-0 bg-muted" :src="preview.activeUrl" alt="attachment preview">
          </div>
          <div
            v-else-if="preview.kind === 'video'"
            class="grid min-h-[520px] place-items-center overflow-auto rounded-xl border border-border p-4"
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

            <!-- Attachment summary -->
            <div class="space-y-1 rounded-xl border border-border bg-muted/30 p-4">
              <span class="text-sm font-semibold text-foreground">{{ text.composer.summaryLabel }}</span>
              <p class="m-0 font-medium text-foreground">{{ selectedFileSummary }}</p>
            </div>

            <!-- Status banner -->
            <div
              :class="[toneClasses(composerStatus.tone), 'rounded-xl border px-4 py-3.5 text-sm font-semibold']"
            >
              {{ composerStatus.message }}
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

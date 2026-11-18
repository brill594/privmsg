<script setup>
import { computed } from "vue";
import {
  Check,
  Copy,
  ExternalLink,
  Lock,
  Plus,
  ShieldCheck
} from "lucide-vue-next";

import { ENCRYPTION_MODE_ENHANCED } from "../../src/shared.js";
import { buildQrSvgData } from "../lib/qrcode.js";
import Button from "./ui/Button.vue";

const props = defineProps({
  shareLink: { type: String, required: true },
  summary: { type: Object, required: true },
  statusMessage: { type: String, default: "" },
  statusClass: { type: String, default: "" },
  copied: { type: Boolean, default: false },
  showQr: { type: Boolean, default: true },
  text: { type: Object, required: true }
});

const emit = defineEmits(["copy-link", "send-new"]);

const shareText = computed(() => props.text.composer.shareView);

const qrData = computed(() => {
  if (!props.shareLink) {
    return null;
  }
  try {
    return buildQrSvgData(props.shareLink, 2);
  } catch {
    return null;
  }
});

function selectLinkText(event) {
  event.target?.select?.();
}
</script>

<template>
  <div class="space-y-6 rounded-2xl border border-border bg-card p-7 shadow-lg">
    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-4">
      <h1 class="text-2xl font-bold text-card-foreground sm:text-3xl">{{ shareText.title }}</h1>

      <Button type="button" @click="emit('send-new')">
        <Plus class="h-4 w-4" />
        {{ shareText.sendNew }}
      </Button>
    </div>

    <!-- Status banner -->
    <div
      v-if="statusMessage"
      :class="[statusClass, 'rounded-xl border px-4 py-3.5 text-sm font-semibold']"
    >
      {{ statusMessage }}
    </div>

    <!-- Security badges -->
    <div
      v-if="summary.hasPassword || summary.encryptionMode === ENCRYPTION_MODE_ENHANCED"
      class="flex flex-wrap gap-2"
    >
      <span
        v-if="summary.hasPassword"
        class="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-400"
      >
        <Lock class="h-3.5 w-3.5" />
        {{ shareText.passwordProtected }}
      </span>
      <span
        v-if="summary.encryptionMode === ENCRYPTION_MODE_ENHANCED"
        class="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
      >
        <ShieldCheck class="h-3.5 w-3.5" />
        {{ shareText.enhancedEncryption }}
      </span>
    </div>

    <!-- Main share area: Link + QR -->
    <div :class="['grid gap-5', showQr && qrData ? 'md:grid-cols-[1fr_auto]' : 'grid-cols-1']">
      <!-- Link panel -->
      <div class="flex min-w-0 flex-col justify-between space-y-4 rounded-xl border border-border bg-muted/30 p-5">
        <div class="space-y-3">
          <h2 class="text-base font-semibold text-card-foreground">{{ text.composer.shareTitle }}</h2>

          <textarea
            :value="shareLink"
            readonly
            rows="3"
            aria-label="share-link"
            class="h-24 w-full resize-none overflow-auto rounded-lg border border-input bg-background/70 px-3.5 py-2.5 font-mono text-sm leading-relaxed text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            @click="selectLinkText"
            @focus="selectLinkText"
          ></textarea>
        </div>

        <div class="flex flex-wrap gap-2.5 pt-1">
          <Button type="button" class="flex-1 sm:flex-none" @click="emit('copy-link')">
            <Check v-if="copied" class="h-4 w-4" />
            <Copy v-else class="h-4 w-4" />
            {{ copied ? shareText.copiedLink : shareText.copyLink }}
          </Button>

          <a
            :href="shareLink"
            target="_blank"
            rel="noreferrer noopener"
            class="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground no-underline shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <ExternalLink class="h-4 w-4" />
            {{ shareText.openLink }}
          </a>
        </div>
      </div>

      <!-- QR panel -->
      <div
        v-if="showQr && qrData"
        class="flex flex-col items-center justify-center space-y-3 rounded-xl border border-border bg-muted/30 p-5 md:w-64"
      >
        <div class="text-center">
          <h3 class="text-sm font-semibold text-card-foreground">{{ shareText.qrTitle }}</h3>
        </div>

        <div class="rounded-xl border border-border bg-white p-3 shadow-sm">
          <svg
            :viewBox="`0 0 ${qrData.viewBoxSize} ${qrData.viewBoxSize}`"
            class="h-40 w-40"
            shape-rendering="crispEdges"
            role="img"
            :aria-label="shareText.qrTitle"
          >
            <rect width="100%" height="100%" fill="#ffffff" />
            <path :d="qrData.path" fill="#111827" />
          </svg>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { Moon, Sun } from "lucide-vue-next";

defineProps({
  isDark: Boolean
});

defineEmits(["toggle"]);
</script>

<template>
  <button
    class="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer"
    type="button"
    :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
    @click="$emit('toggle')"
  >
    <Sun v-if="isDark" class="h-4 w-4" />
    <Moon v-else class="h-4 w-4" />
  </button>
</template>

<script setup>
import { computed, useAttrs } from "vue";
import { cn } from "../../lib/utils.js";

defineOptions({ inheritAttrs: false });

const props = defineProps({
  variant: { type: String, default: "default" },
  size: { type: String, default: "default" }
});

const attrs = useAttrs();

const variants = {
  default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
  outline: "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
  ghost: "hover:bg-accent hover:text-accent-foreground"
};

const sizes = {
  default: "h-10 px-4 py-2",
  sm: "h-8 px-3 text-xs",
  lg: "h-12 px-6 text-base",
  icon: "h-9 w-9"
};

const classes = computed(() => {
  const { class: extraClass } = attrs;
  return cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
    variants[props.variant] || variants.default,
    sizes[props.size] || sizes.default,
    extraClass
  );
});

const filteredAttrs = computed(() => {
  const { class: _, ...rest } = attrs;
  return rest;
});
</script>

<template>
  <button :class="classes" v-bind="filteredAttrs">
    <slot />
  </button>
</template>

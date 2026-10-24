<script setup lang="ts">
import { computed } from 'vue';
import { useArchiveNavigation } from '../app/navigation';

const props = defineProps<{ id: string }>();
const navigation = useArchiveNavigation();
const target = computed(() => ({ name: 'detail', params: { dynamicId: props.id } }));

function normalClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** 选中文字时不把点击解释为导航，方便复制正文。 */
function selectedText(): boolean {
  return window.getSelection()?.isCollapsed === false;
}

function open(): void {
  navigation.openDetail(props.id);
}

function cardClick(event: MouseEvent): void {
  if (!normalClick(event) || selectedText() || event.defaultPrevented) return;
  if (event.target instanceof Element
    && event.target.closest('a, button, input, select, textarea, [data-display-identity]')) return;
  open();
}

function linkClick(event: MouseEvent): void {
  // 组合键/中键交给浏览器原生“新标签页”等语义；普通点击统一走导航协调器。
  if (!normalClick(event)) return;
  event.preventDefault();
  if (!selectedText()) open();
}
</script>

<template>
  <article class="dynamic-card" :data-reading-id="id" @click="cardClick">
    <RouterLink v-slot="{ href }" :to="target" custom>
      <a
        class="card-link"
        :href="href"
        :aria-label="`阅读全文 ${id}`"
        @click="linkClick"
      />
    </RouterLink>
    <slot />
  </article>
</template>

<style scoped>
.dynamic-card {
  position: relative;
  isolation: isolate;
  min-width: 0;
  padding: 20px 20px 4px;
  margin: 8px 0;
  background: var(--card-bg);
  border-radius: var(--radius);
  cursor: pointer;
}
/* 独立链接提供键盘与新标签页语义；正文与内部操作浮在链接之上。 */
.card-link {
  position: absolute;
  inset: 0;
  border-radius: inherit;
}
.card-link:focus-visible {
  outline: 3px solid var(--brand);
  outline-offset: -3px;
}
.dynamic-card :slotted(*) {
  position: relative;
  z-index: 1;
}
@media (max-width: 480px) {
  .dynamic-card {
    padding: 16px 12px 4px;
  }
}
</style>

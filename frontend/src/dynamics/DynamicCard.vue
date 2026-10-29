<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useArchiveNavigation } from '../app/navigation';
import { openInNewTab } from '../app/newTab';

const props = defineProps<{
  id: string;
  /**
   * 宽屏正文入口在独立标签页打开，窄屏站内进入详情。
   * 卡片评论按钮的宽窄屏分支由宿主决定，不在这里判断（窄屏才走详情定位）。
   */
  tabbed: boolean;
}>();
const router = useRouter();
const navigation = useArchiveNavigation();
const target = computed(() => ({ name: 'detail', params: { dynamicId: props.id } }));
/** 与链接同一个解析结果：新标签地址含路由基址，复制/刷新都能直接读取。 */
const detailHref = computed(() => router.resolve(target.value).href);

function normalClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** 选中文字时不把点击解释为导航，方便复制正文。 */
function selectedText(): boolean {
  return window.getSelection()?.isCollapsed === false;
}

function open(): void {
  if (props.tabbed) openInNewTab(detailHref.value);
  else navigation.openDetail(props.id);
}

function cardClick(event: MouseEvent): void {
  if (!normalClick(event) || selectedText() || event.defaultPrevented) return;
  // `[data-comment-region]`：卡片内联评论区里的文本、图片与分页都是内部操作，不导航正文。
  if (event.target instanceof Element
    && event.target.closest('a, button, input, select, textarea, [data-display-identity], [data-comment-region]')) return;
  open();
}

function linkClick(event: MouseEvent): void {
  // 组合键/中键一律交给浏览器原生“新标签页”等语义，避免与下面的入口重复开窗。
  if (!normalClick(event)) return;
  if (props.tabbed) {
    // 宽屏：链接自己带 target/rel，普通点击由浏览器开新标签；只有选中文字时才阻止。
    if (selectedText()) event.preventDefault();
    return;
  }
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
        :target="tabbed ? '_blank' : undefined"
        :rel="tabbed ? 'noopener' : undefined"
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
  /* 卡片内距与卡片间距按宽窄屏切换（手机 16/12，桌面 24/16）。 */
  padding: var(--card-padding) var(--card-padding) 8px;
  margin: 0 0 var(--card-gap);
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
</style>

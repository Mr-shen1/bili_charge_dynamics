<script setup lang="ts">
import { displayCount } from './display';

defineProps<{ count: number | null }>();
</script>

<template>
  <!-- 归档点赞数仅展示：没有 button/link，不提供真实点赞操作。 -->
  <span class="read-only-like" role="group" :aria-label="`点赞 ${displayCount(count)}`">
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none"
      stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
      <path d="M7 10v10H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3Zm0 0 4.2-7.4A1.6 1.6 0 0 1 14 3.4l.4 4.1h4.5a2 2 0 0 1 2 2.4l-1.4 8A2 2 0 0 1 17.5 20H7" />
    </svg>
    <span aria-hidden="true">{{ displayCount(count) }}</span>
  </span>
</template>

<style scoped>
.read-only-like {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 24px;
  color: var(--muted);
  /* 计数属时间/计数层 13px；行高跟 24px 图标/命中盒同值以垂直居中，不是排版行高。 */
  font-size: var(--font-meta);
  line-height: 24px;
}
</style>

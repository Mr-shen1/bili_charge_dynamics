<script setup lang="ts">
import { computed } from 'vue';
import { ElButton } from 'element-plus';

/**
 * 单按钮排序控件：文字只表示**当前**排序，点击切到另一种。
 * 一级评论与手机回复详情共用同一形状与文案（设计 §4），只在各自头部按区域放置。
 */
const props = defineProps<{ hot: boolean }>();
const emit = defineEmits<{ toggle: [] }>();

const text = computed(() => (props.hot ? '按热度' : '按时间'));
const label = computed(() => (props.hot
  ? '当前按热度，点击切换为按时间'
  : '当前按时间，点击切换为按热度'));
</script>

<template>
  <el-button link class="sort-toggle" :aria-label="label" @click="emit('toggle')">
    <span class="sort-toggle__icon" aria-hidden="true">☰</span>
    {{ text }}
  </el-button>
</template>

<style scoped>
/* 13/20 与计数同层级；点击区仍由 44px 高度承担，视觉只显示图标与文字。 */
.sort-toggle {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 80px;
  min-height: var(--touch);
  padding: 0;
  justify-content: flex-end;
  color: var(--muted);
  font-size: var(--font-meta);
  line-height: var(--line-meta);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.sort-toggle:hover,
.sort-toggle:focus {
  color: var(--brand-strong);
}
.sort-toggle:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.sort-toggle__icon {
  font-size: var(--font-meta);
  line-height: var(--line-meta);
}
</style>

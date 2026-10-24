<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { ElButton } from 'element-plus';

// scrollHeight 按整数像素取整，留一个像素避免恰好六行误判。
const layoutRoundingTolerance = 1;

const props = withDefaults(defineProps<{ text: string; expanded: boolean; subject?: '正文' | '评论' | '回复正文' }>(), {
  subject: '正文',
});
const emit = defineEmits<{ toggle: [] }>();
const paragraph = ref<HTMLParagraphElement | null>(null);
const overflowing = ref(false);
const id = useId();
let observer: ResizeObserver | null = null;

function measure(): void {
  const element = paragraph.value;
  if (!element) return;
  const style = getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const collapsedLines = Number.parseFloat(style.getPropertyValue('--collapsed-lines')) || 6;
  overflowing.value = Number.isFinite(lineHeight)
    && element.scrollHeight > lineHeight * collapsedLines + layoutRoundingTolerance;
}

onMounted(() => {
  measure();
  if (typeof ResizeObserver !== 'undefined' && paragraph.value) {
    observer = new ResizeObserver(measure);
    observer.observe(paragraph.value);
  }
});
onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
watch(() => props.text, measure, { flush: 'post' });
</script>

<template>
  <p :id="id" ref="paragraph" class="text" :class="{ collapsed: !expanded }"><slot name="prefix" />{{ text }}</p>
  <el-button
    v-if="overflowing"
    type="primary"
    link
    class="fold-toggle"
    :aria-expanded="expanded"
    :aria-label="`${expanded ? '收起' : '展开'}${subject}`"
    :aria-controls="id"
    @click="emit('toggle')"
  >{{ expanded ? '收起' : '展开' }}</el-button>
</template>

<style scoped>
.text {
  --collapsed-lines: 6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 25px;
  font-size: 16px;
  font-weight: 400;
  margin: 8px 0;
  min-width: 0;
}
.collapsed {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--collapsed-lines);
  max-height: calc(var(--collapsed-lines) * 1lh);
  overflow: hidden;
}
.fold-toggle {
  min-height: var(--touch);
  font-size: 16px;
  line-height: 25px;
}
</style>

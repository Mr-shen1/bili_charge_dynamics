<script setup lang="ts">
import { computed } from 'vue';
import { ElButton } from 'element-plus';
import { replyPageEntries } from './replyPaging';
import { useCompactViewport } from '../app/useCompactViewport';

const props = defineProps<{ page: number; pages: number; busy: boolean }>();
const emit = defineEmits<{ select: [number]; collapse: [] }>();

const compact = useCompactViewport();
const entries = computed(() => replyPageEntries(props.page, props.pages, compact.value));
</script>

<template>
  <nav class="reply-pager" aria-label="回复分页">
    <span class="reply-pager__total">共{{ pages }}页</span>
    <el-button
      v-if="page > 1"
      link
      class="reply-pager__action"
      :disabled="busy"
      @click="emit('select', page - 1)"
    >上一页</el-button>
    <template v-for="(entry, index) in entries" :key="entry === '…' ? `gap-${index}` : entry">
      <span v-if="entry === '…'" class="reply-pager__gap" aria-hidden="true">…</span>
      <el-button
        v-else
        link
        class="reply-pager__page"
        :aria-current="entry === page ? 'page' : undefined"
        :disabled="busy"
        @click="emit('select', entry)"
      >{{ entry }}</el-button>
    </template>
    <el-button
      link
      class="reply-pager__action"
      :disabled="busy || page >= pages"
      :aria-busy="busy || undefined"
      @click="emit('select', Math.min(page + 1, pages))"
    >下一页</el-button>
    <el-button link class="reply-pager__action" @click="emit('collapse')">收起</el-button>
  </nav>
</template>

<style scoped>
.reply-pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 8px 0 4px;
}
.reply-pager__total {
  margin-right: 4px;
  color: var(--muted);
  font-size: 13px;
  line-height: 24px;
}
.reply-pager__action,
.reply-pager__page {
  min-height: var(--touch);
  padding: 0 6px;
  font-size: 13px;
}
.reply-pager__page[aria-current='page'] {
  color: var(--brand-strong);
  font-weight: 600;
}
.reply-pager__gap {
  padding: 0 2px;
  color: var(--muted);
}
</style>

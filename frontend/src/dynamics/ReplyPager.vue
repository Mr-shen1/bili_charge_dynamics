<script setup lang="ts">
import { computed } from 'vue';
import { ElButton } from 'element-plus';
import { replyPageEntries } from './replyPaging';
import { useCompactViewport } from '../app/useCompactViewport';

// 分页器只负责翻页：不提供“收起”等区域动作，行内整体居中。
const props = defineProps<{ page: number; pages: number; busy: boolean }>();
const emit = defineEmits<{ select: [number] }>();

const compact = useCompactViewport();
const entries = computed(() => replyPageEntries(props.page, props.pages, compact.value));

/** 首尾越界一律夹回有效页码：上一页/下一页始终在位，只是到边时禁用。 */
function go(target: number): void {
  emit('select', Math.min(Math.max(target, 1), props.pages));
}
</script>

<template>
  <nav class="reply-pager" aria-label="回复分页">
    <!-- 参考 el-pagination 的 prev/pager/next：箭头常驻、页码方格、当前页实底，
         不额外显示总数（页数由最后一个页码表达）；页码窗口沿用 replyPaging 的既有口径。 -->
    <el-button
      class="reply-pager__step"
      :disabled="busy || page <= 1"
      aria-label="上一页"
      @click="go(page - 1)"
    ><span class="reply-pager__chip" aria-hidden="true">‹</span></el-button>
    <template v-for="(entry, index) in entries" :key="entry === '…' ? `gap-${index}` : entry">
      <span v-if="entry === '…'" class="reply-pager__gap" aria-hidden="true">…</span>
      <el-button
        v-else
        class="reply-pager__page"
        :aria-current="entry === page ? 'page' : undefined"
        :disabled="busy"
        @click="go(entry)"
      ><span class="reply-pager__chip">{{ entry }}</span></el-button>
    </template>
    <el-button
      class="reply-pager__step"
      :disabled="busy || page >= pages"
      :aria-busy="busy || undefined"
      aria-label="下一页"
      @click="go(page + 1)"
    ><span class="reply-pager__chip" aria-hidden="true">›</span></el-button>
  </nav>
</template>

<style scoped>
/* 整行居中：分页只是这一行的内容，不再被“收起”之类动作挤偏。 */
.reply-pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px 4px 4px;
}
/* 按钮本身保留 44px 触控区；可见方格缩一号到 36×36，两者都是正方形。 */
.el-button.reply-pager__page,
.el-button.reply-pager__step {
  width: var(--touch);
  min-width: var(--touch);
  height: var(--touch);
  min-height: var(--touch);
  padding: 0;
  border: 0;
  background: transparent;
}
.reply-pager__chip {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--card-bg);
  color: var(--text);
  /* 分页文字属时间/计数层，数字等宽便于扫读。 */
  font-size: var(--font-meta);
  font-variant-numeric: tabular-nums;
}
.el-button.reply-pager__step .reply-pager__chip {
  color: var(--text);
  font-size: 16px;
  line-height: 1;
}
.el-button.reply-pager__page:hover .reply-pager__chip,
.el-button.reply-pager__step:not(.is-disabled):hover .reply-pager__chip {
  border-color: var(--brand);
  color: var(--brand-strong);
}
.el-button.reply-pager__page[aria-current='page'] .reply-pager__chip {
  border-color: var(--brand);
  background: var(--brand);
  color: #ffffff;
  font-weight: 600;
}
/* 首页/末页：方格还在，只把箭头标灰，翻页时布局不跳。 */
.el-button.reply-pager__step.is-disabled .reply-pager__chip {
  border-color: var(--line);
  background: var(--card-bg);
  color: var(--muted);
}
.reply-pager__gap {
  padding: 0 2px;
  color: var(--muted);
}
</style>

<script setup lang="ts">
import { computed } from 'vue';
import { ElButton } from 'element-plus';
import { replyPageEntries } from './replyPaging';

// 分页器只负责翻页：不提供“收起”等区域动作。
const props = defineProps<{ page: number; pages: number; busy: boolean }>();
const emit = defineEmits<{ select: [number] }>();

const entries = computed(() => replyPageEntries(props.page, props.pages));
/** 页码多到一屏摆不满时铺开对齐两侧；页数少时居中，避免按钮被拉成稀疏一排。 */
const wide = computed(() => entries.value.length > 5);

/** 首尾越界一律夹回有效页码：上一页/下一页始终在位，只是到边时禁用。 */
function go(target: number): void {
  emit('select', Math.min(Math.max(target, 1), props.pages));
}
</script>

<template>
  <nav class="reply-pager" :class="{ 'reply-pager--wide': wide }" aria-label="回复分页">
    <!-- 参考 el-pagination 的 prev/pager/next：箭头常驻、页码方格、当前页实底，
         保留首尾页与 5 页窗口（1 … 37 38 39 40 41 … 46），不显示总页数。 -->
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
/* 宽度上限让宽屏不把 9 个按钮拉散；窄屏由父级内距决定，正好铺满一屏。 */
.reply-pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 2px;
  max-width: 420px;
  margin: 0 auto;
  padding: 8px 4px 4px;
}
/* 库的默认相邻按钮外边距会把这行顶到换行，分页器自己用 gap 控制间距。 */
.reply-pager .el-button + .el-button {
  margin-left: 0;
}
/* 页码超过 5 个时铺满一行：首尾两个按钮与上方回复的左右边缘对齐。 */
.reply-pager--wide {
  justify-content: space-between;
}
/* 按钮保留 44px 触控高度；可见方格 28×28，9 个格子加两个省略号在 360px 也排得下。 */
.el-button.reply-pager__page,
.el-button.reply-pager__step {
  width: 28px;
  min-width: 28px;
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
  width: 28px;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--card-bg);
  color: var(--text);
  /* 分页文字比正文小一号：12px 数字等宽，便于扫读页码。 */
  font-size: var(--font-badge);
  font-variant-numeric: tabular-nums;
}
.el-button.reply-pager__step .reply-pager__chip {
  color: var(--text);
  font-size: 13px;
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
  color: var(--muted);
  font-size: var(--font-badge);
  line-height: 28px;
  white-space: nowrap;
}
</style>

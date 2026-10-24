<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowRef } from 'vue';
import { ElButton, ElRadioButton, ElRadioGroup } from 'element-plus';
import type { ArchiveMetadata, CommentSort } from '../data/contracts';
import type { CommentSnapshot } from '../app/snapshots';
import { emptyCommentSnapshot } from '../app/snapshots';
import { useSession } from '../app/session';
import { onUserScroll } from '../app/readingPosition';
import { displayCount } from './display';
import CommentList from './CommentList.vue';

const props = defineProps<{
  dynamicId: string;
  authorId: string;
  sourceCommentCount: number | null;
  archive?: ArchiveMetadata;
  snapshot: CommentSnapshot;
  target: 'top' | 'comments';
  /** 用户已经主动操作过页面时，迟到的入口/排序定位不再抢回。 */
  canLocate: boolean;
}>();
const emit = defineEmits<{ 'update:snapshot': [CommentSnapshot] }>();
const { reader } = useSession();
// 读取器声明不具备讨论能力时整块显示未归档，不发评论请求。
const unarchived = computed(() => reader.discussions === 'not-archived');

const sort = ref<CommentSort>(props.snapshot.sort);
const reloadKey = ref(0);
const currentSnapshot = shallowRef<CommentSnapshot>(props.snapshot);
const root = ref<HTMLElement | null>(null);
// 主动入口/切换排序的定位意图只消费一次：失败/取消后不反复抢用户滚动。
let entryPending = props.target === 'comments';
let sortPending = false;
let releaseSortCancel = (): void => undefined;
const listKey = computed(() => `${sort.value}:${reloadKey.value}`);
const sourceCount = computed(() => props.archive?.commentSync?.sourceCommentCount ?? props.sourceCommentCount);
const headingLabel = computed(() => `${props.archive ? '来源' : ''}评论 ${displayCount(sourceCount.value)}`);

function locate(): void {
  root.value?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
}

function settle(): void {
  if (entryPending && props.canLocate) {
    entryPending = false;
    locate();
  }
  if (sortPending) {
    sortPending = false;
    releaseSortCancel();
    locate();
  }
}

// 新批次落下前用户若主动滚动，就不再抢回评论区顶部。
function armSortLocate(): void {
  // 连续切换只保留最新一次待定位，避免旧的取消监听滞留到卸载。
  releaseSortCancel();
  sortPending = true;
  releaseSortCancel = onUserScroll(() => {
    sortPending = false;
    releaseSortCancel();
  });
}

onUnmounted(() => { releaseSortCancel(); });

function publish(next: CommentSnapshot): void {
  currentSnapshot.value = next;
  emit('update:snapshot', next);
}

const sortModel = computed<CommentSort>({
  get: () => sort.value,
  set: next => {
    if (next === sort.value) return;
    // 切换排序：定位评论区，重置目标排序首批、文字与回复展开状态（列表整体重挂载）。
    sort.value = next;
    reloadKey.value += 1;
    entryPending = false;
    publish(emptyCommentSnapshot(next));
    locate();
    armSortLocate();
    // 旧批次卸载后页面高度会收缩，滚动位置可能被浏览器夹紧；本帧内再定位一次。
    void nextTick(() => { if (sort.value === next && sortPending) locate(); });
  },
});

function restartReading(): void {
  reloadKey.value += 1;
  publish(emptyCommentSnapshot(sort.value));
}
</script>

<template>
  <section ref="root" class="comment-section" aria-label="评论区">
    <header class="comment-heading">
      <h2>
        <el-button link class="comment-tab" :aria-label="headingLabel" @click="locate">
          评论 <span class="comment-count">{{ displayCount(sourceCount) }}</span>
        </el-button>
      </h2>
      <el-radio-group v-if="!unarchived" v-model="sortModel" class="comment-sort" aria-label="评论排序">
        <el-radio-button value="hot">最热</el-radio-button>
        <el-radio-button value="latest">最新</el-radio-button>
      </el-radio-group>
    </header>
    <p v-if="unarchived" class="comment-unarchived" role="status">
      评论尚未归档；来源计数不代表本地已有评论。
    </p>
    <CommentList
      v-else
      :key="listKey"
      :dynamic-id="dynamicId"
      :author-id="authorId"
      :sort="sort"
      :archive="archive"
      :initial="currentSnapshot"
      @update="publish"
      @settled="settle"
      @restart="restartReading"
    />
  </section>
</template>

<style scoped>
.comment-section {
  min-width: 0;
  margin-top: 16px;
  padding: 8px 20px 24px;
  background: var(--card-bg);
  border-radius: var(--radius);
}
.comment-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0;
}
.comment-heading h2 {
  margin: 0;
  font-size: 17px;
  line-height: 24px;
}
.comment-tab {
  min-height: var(--touch);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--brand-strong);
  font: inherit;
  font-size: 17px;
  font-weight: 600;
  cursor: pointer;
}
.comment-tab:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.comment-count {
  color: var(--brand);
}
.comment-sort {
  flex: 0 0 auto;
}
.comment-unarchived {
  margin: 0;
  padding: 12px 0;
  color: var(--muted);
  line-height: 1.7;
  overflow-wrap: anywhere;
}
@media (max-width: 480px) {
  .comment-section {
    padding: 8px 12px 20px;
  }
}
</style>

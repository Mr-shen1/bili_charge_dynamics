<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowRef } from 'vue';
import { ElButton } from 'element-plus';
import type { ArchiveMetadata, CommentSort } from '../data/contracts';
import type { CommentSnapshot } from '../app/snapshots';
import { adoptCommentSnapshot, emptyCommentSnapshot } from '../app/snapshots';
import { useSession } from '../app/session';
import { onUserScroll } from '../app/readingPosition';
import { useCompactViewport } from '../app/useCompactViewport';
import { displayCount } from './display';
import CommentList from './CommentList.vue';
import SortToggle from './SortToggle.vue';

const props = defineProps<{
  /**
   * 区域身份：读取与交互状态按它隔离，供同一页面挂载多个一级评论区域。
   * 不传时按详情入口生成，现有详情入口不需要额外参数即可直接使用；
   * 身份是显式上下文，不读写 DOM id，也不存在唯一的全局排序。
   */
  regionId?: string;
  dynamicId: string;
  authorId: string;
  sourceCommentCount: number | null;
  archive?: ArchiveMetadata;
  snapshot: CommentSnapshot;
  target: 'top' | 'comments';
  /** 用户已经主动操作过页面时，迟到的入口/排序定位不再抢回。 */
  canLocate: boolean;
  /** 精确入口的目标一级评论：定位到该条而不是评论区顶部。 */
  locateRootId?: string | null;
  /** 精确入口的目标楼中楼回复：根评论只作定位上下文，滚动交给目标回复本身。 */
  locateReplyId?: string | null;
  /** 本次访问是否仍待执行主动入口定位；历史恢复（已有快照）为 false，按位置还原。 */
  locateOnEntry?: boolean;
  /**
   * 标题只显示计数、不再带“定位评论区”按钮：列表卡片内联区已经由卡片评论入口
   * 展开并定位，同一个卡片里再放一个同名按钮只会让读屏用户分不清。
   * 布尔 prop 缺省是 false，因此这里用“静态标题”而不是“是否带按钮”命名。
   */
  staticHeading?: boolean;
}>();
const emit = defineEmits<{ 'update:snapshot': [CommentSnapshot] }>();
const { reader } = useSession();
// 宽屏内联回复区由本票交付；窄屏改用独立楼中楼入口，由 07 交付。
const compact = useCompactViewport();
// 读取器声明不具备讨论能力时整块显示未归档，不发评论请求。
const unarchived = computed(() => reader.discussions === 'not-archived');

const regionId = computed(() => props.regionId ?? `detail:${props.dynamicId}`);
// 只采纳本区域的快照：别的区域的排序、批次与展开状态不能冒充成本区域的阅读状态。
const initial = adoptCommentSnapshot(props.snapshot, regionId.value);
const sort = ref<CommentSort>(initial.sort);
const reloadKey = ref(0);
const currentSnapshot = shallowRef<CommentSnapshot>(initial);
const root = ref<HTMLElement | null>(null);
// 主动入口/切换排序的定位意图只消费一次：失败/取消后不反复抢用户滚动。
// 回复精确入口先定位到目标回复，根评论不再单独抢占滚动。
const locateRootOnly = computed(() => Boolean(props.locateRootId) && !props.locateReplyId);
let entryPending = (props.locateOnEntry ?? true)
  && (props.target === 'comments' || locateRootOnly.value);
let sortPending = false;
let releaseSortCancel = (): void => undefined;
// 区域身份进入重挂载键：同一页面复用组件实例时，区域变化不会沿用别的区域的列表状态。
const listKey = computed(() => `${regionId.value}:${sort.value}:${reloadKey.value}`);
const sourceCount = computed(() => props.archive?.commentSync?.sourceCommentCount ?? props.sourceCommentCount);
const headingLabel = computed(() => `${props.archive ? '来源' : ''}评论 ${displayCount(sourceCount.value)}`);

// 精确定位的目标元素：按业务锚点查找，不依赖评论是否在首批 DOM 里。
function targetElement(id: string): HTMLElement | null {
  const anchors = root.value?.querySelectorAll<HTMLElement>('[data-reading-id]') ?? [];
  return Array.from(anchors).find(element => element.dataset.readingId === `comment:${id}`) ?? null;
}

function locate(): void {
  const target = props.locateRootId ? targetElement(props.locateRootId) : null;
  // 目标确实可读才定位到它；读不到时退回评论区顶部，绝不把页首当作定位结果。
  (target ?? root.value)?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
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
  // 转发时补上区域身份：快照永远知道自己属于哪个区域，容器按它区分多区域状态。
  const tagged = next.regionId === regionId.value ? next : { ...next, regionId: regionId.value };
  currentSnapshot.value = tagged;
  emit('update:snapshot', tagged);
}

// 切换排序：定位评论区，重置目标排序首批、文字与回复展开状态（列表整体重挂载）。
function switchSort(next: CommentSort): void {
  if (next === sort.value) return;
  sort.value = next;
  reloadKey.value += 1;
  // 精确入口切换排序后仍以同一目标为首批锚点，不退回普通首批。
  entryPending = locateRootOnly.value;
  publish(emptyCommentSnapshot(next));
  locate();
  armSortLocate();
  // 旧批次卸载后页面高度会收缩，滚动位置可能被浏览器夹紧；本帧内再定位一次。
  void nextTick(() => { if (sort.value === next && sortPending) locate(); });
}

// 单按钮只切换一次：显示的是当前排序，点击后换成另一种。
function toggleSort(): void {
  switchSort(sort.value === 'latest' ? 'hot' : 'latest');
}

function restartReading(): void {
  reloadKey.value += 1;
  publish(emptyCommentSnapshot(sort.value));
}
</script>

<template>
  <section ref="root" class="comment-section" :data-comment-region="regionId" aria-label="评论区">
    <header class="comment-heading">
      <h2>
        <el-button v-if="!staticHeading" link class="comment-tab" :aria-label="headingLabel" @click="locate">
          评论 <span class="comment-count">{{ displayCount(sourceCount) }}</span>
        </el-button>
        <span v-else class="comment-tab comment-tab--static">
          评论 <span class="comment-count">{{ displayCount(sourceCount) }}</span>
        </span>
      </h2>
      <SortToggle
        v-if="!unarchived"
        class="comment-sort"
        :hot="sort === 'hot'"
        @toggle="toggleSort"
      />
    </header>
    <p v-if="unarchived" class="comment-unarchived" role="status">
      评论尚未保存；来源计数不代表本地已有评论。
    </p>
    <CommentList
      v-else
      :key="listKey"
      :region-id="regionId"
      :dynamic-id="dynamicId"
      :author-id="authorId"
      :sort="sort"
      :archive="archive"
      :compact="compact"
      :initial="currentSnapshot"
      :anchor-id="locateRootId ?? null"
      :locate-reply-id="locateReplyId ?? null"
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
  font-size: var(--font-section);
  line-height: var(--line-section);
  font-weight: 500;
}
.comment-tab {
  min-height: var(--touch);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--brand-strong);
  font: inherit;
  font-size: var(--font-section);
  line-height: var(--line-section);
  font-weight: 500;
  cursor: pointer;
}
.comment-tab--static {
  display: inline-block;
  cursor: default;
}
.comment-tab:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.comment-count {
  margin-left: 2px;
  color: var(--brand);
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

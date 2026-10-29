<script setup lang="ts">
import { nextTick, onUnmounted, ref } from 'vue';
import { ElButton } from 'element-plus';
import type { ArchiveScope } from '../data/contracts';
import type { CommentSnapshot } from '../app/snapshots';
import { emptyCommentSnapshot, listCommentRegionId, listCommentSnapshots } from '../app/snapshots';
import { useSession } from '../app/session';
import { useArchiveNavigation } from '../app/navigation';
import { onUserScroll } from '../app/readingPosition';
import { useCompactViewport } from '../app/useCompactViewport';
import { useVisitPosition } from '../app/useVisitPosition';
import { useListRead } from './useListRead';
import ArchiveNavigation from './ArchiveNavigation.vue';
import CommentSection from './CommentSection.vue';
import DynamicCard from './DynamicCard.vue';
import DynamicContent from './DynamicContent.vue';
import ReadNotice from './ReadNotice.vue';

const props = defineProps<{ scope: ArchiveScope }>();
// 列表卡片最多展示九张缩略图；完整图片组仍通过预览访问。
const listThumbnailLimit = 9;
const { reader } = useSession();
const navigation = useArchiveNavigation();
// 窄屏保持既有入口：站内进入详情并定位评论区，不在列表里另开一套内联评论。
const compact = useCompactViewport();
// 访问身份在 setup 时固定：卸载时仍按本次访问保存，不受已经切换的路由影响。
const pageEntryId = navigation.pageEntryId;
const initial = navigation.listSnapshot;
const { state, load } = useListRead(reader, props.scope, initial?.read);
const expanded = ref<Record<string, boolean>>({ ...(initial?.expanded ?? {}) });
const root = ref<HTMLElement | null>(null);

/**
 * 卡片内联评论面板：读取与交互状态属于该卡片自己的区域身份（`list:{动态 ID}`）。
 * 收起只停读与隐藏，面板状态留在本次访问里，再展开仍是同一排序与已读批次；
 * 离开列表访问时只把仍展开的面板写进快照，历史恢复才能按卡片还原。
 */
interface CardComments {
  readonly snapshot: CommentSnapshot;
  readonly open: boolean;
  /** 由本次点击展开：首批落下后定位评论区；历史恢复的展开不再抢滚动。 */
  readonly entryLocate: boolean;
  /** 用户在新批次落下前已主动滚动，迟到的入口定位让位。 */
  readonly canLocate: boolean;
}

const cardComments = ref<Record<string, CardComments>>(
  Object.fromEntries(Object.entries(listCommentSnapshots(initial)).map(([dynamicId, snapshot]) => [dynamicId, {
    snapshot, open: true, entryLocate: false, canLocate: false,
  }])),
);
// 每个面板一组“用户已接管滚动”的监听；收起、卸载与重新展开前都要解除上一组。
const releases = new Map<string, () => void>();
const cardRefs = new Map<string, { focusCommentEntry(): void }>();

function setCardRef(dynamicId: string, element: unknown): void {
  if (element) cardRefs.set(dynamicId, element as { focusCommentEntry(): void });
  else cardRefs.delete(dynamicId);
}

function update(dynamicId: string, panel: CardComments): void {
  cardComments.value = { ...cardComments.value, [dynamicId]: panel };
}

function release(dynamicId: string): void {
  releases.get(dynamicId)?.();
  releases.delete(dynamicId);
}

/** 新批次落下前用户若主动滚动，就不再抢回评论区（与详情入口同一判据）。 */
function armLocate(dynamicId: string): void {
  release(dynamicId);
  releases.set(dynamicId, onUserScroll(() => {
    release(dynamicId);
    const panel = cardComments.value[dynamicId];
    if (panel?.canLocate) update(dynamicId, { ...panel, canLocate: false });
  }));
}

function openCard(dynamicId: string, previous?: CardComments): void {
  update(dynamicId, {
    // 再展开沿用同一面板的排序、批次与回复页码，不退回默认首批。
    snapshot: previous?.snapshot ?? emptyCommentSnapshot(),
    open: true,
    entryLocate: true,
    canLocate: true,
  });
  armLocate(dynamicId);
}

function collapseCard(dynamicId: string): void {
  const panel = cardComments.value[dynamicId];
  if (!panel?.open) return;
  update(dynamicId, { ...panel, open: false, entryLocate: false, canLocate: false });
  release(dynamicId);
  // 收起后把焦点与视线交还卡片的评论入口，不落到页首或丢掉阅读位置。
  void nextTick(() => { cardRefs.get(dynamicId)?.focusCommentEntry(); });
}

/** 桌面：在卡片下方展开／收起一级评论；窄屏：保持原站内入口。 */
function toggleComments(dynamicId: string): void {
  if (compact.value) {
    navigation.openDetail(dynamicId, 'comments');
    return;
  }
  const panel = cardComments.value[dynamicId];
  if (panel?.open) collapseCard(dynamicId);
  else openCard(dynamicId, panel);
}

function setComment(dynamicId: string, snapshot: CommentSnapshot): void {
  const panel = cardComments.value[dynamicId];
  if (!panel) return;
  update(dynamicId, { ...panel, snapshot });
}

/** 离开时仍在读取的面板按“已取消”保存，返回后可从这个 cursor 继续。 */
function savedComment(snapshot: CommentSnapshot): CommentSnapshot {
  return snapshot.read.status === 'loading'
    ? { ...snapshot, read: { ...snapshot.read, status: 'cancelled' } }
    : snapshot;
}

onUnmounted(() => {
  for (const dynamicId of [...releases.keys()]) release(dynamicId);
});

useVisitPosition(root, initial?.position ?? null, position => {
  const read = state.value;
  const comments = Object.fromEntries(Object.entries(cardComments.value)
    .filter(([, panel]) => panel.open)
    .map(([dynamicId, panel]) => [dynamicId, savedComment(panel.snapshot)]));
  navigation.saveListSnapshot(pageEntryId, {
    // 离开时仍在读取的批次按“已取消”保存，返回后可从原 cursor 继续。
    read: read.status === 'loading' ? { ...read, status: 'cancelled' } : read,
    expanded: { ...expanded.value },
    comments,
    position,
  });
});

function toggle(id: string): void {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] };
}

function foldingFor(id: string): { expanded: boolean; toggle(): void } {
  return { expanded: expanded.value[id] ?? false, toggle: () => toggle(id) };
}
</script>

<template>
  <div ref="root" class="list-visit">
    <ArchiveNavigation :scope="scope" />
    <div v-if="state.reason === 'invalid-cursor'" class="list-notice">
      <p role="alert">分页已失效，请重新开始读取。</p>
      <el-button type="primary" link class="list-action" @click="load(true)">重新开始</el-button>
    </div>
    <p v-if="state.reason === 'unknown-up'" class="list-notice" role="status">UP 不存在</p>
    <ReadNotice
      v-else-if="!state.data && state.reason !== 'invalid-cursor'"
      :status="state.status"
      area="动态列表"
      @retry="load()"
    />
    <p v-if="state.data && state.data.items.length === 0" class="list-notice" role="status">暂无动态</p>
    <DynamicCard v-for="dynamic in state.data?.items ?? []" :key="dynamic.id" :id="dynamic.id" :tabbed="!compact">
      <div class="card-content">
        <DynamicContent
          :ref="element => setCardRef(dynamic.id, element)"
          :dynamic="dynamic"
          :folding="foldingFor(dynamic.id)"
          :image-display-limit="listThumbnailLimit"
          @comments="toggleComments(dynamic.id)"
        />
        <CommentSection
          v-if="!compact && cardComments[dynamic.id]?.open"
          :region-id="listCommentRegionId(dynamic.id)"
          :dynamic-id="dynamic.id"
          :author-id="dynamic.author.id"
          :source-comment-count="dynamic.commentCount"
          :archive="dynamic.archive"
          :snapshot="cardComments[dynamic.id]!.snapshot"
          target="comments"
          :static-heading="true"
          :can-locate="cardComments[dynamic.id]!.canLocate"
          :locate-on-entry="cardComments[dynamic.id]!.entryLocate"
          @update:snapshot="setComment(dynamic.id, $event)"
        />
      </div>
    </DynamicCard>
    <template v-if="state.data && state.data.items.length > 0">
      <p v-if="state.data.nextCursor === null" class="list-notice" role="status">动态已加载完毕</p>
      <section v-else class="list-append" aria-label="动态追加">
        <ReadNotice
          v-if="state.status !== 'success' && state.reason !== 'invalid-cursor'"
          :status="state.status"
          area="动态追加"
          @retry="load()"
        />
        <el-button
          v-if="state.status === 'success' || state.status === 'loading'"
          type="primary"
          class="list-action"
          :disabled="state.status === 'loading'"
          @click="load()"
        >加载更多</el-button>
      </section>
    </template>
  </div>
</template>

<style scoped>
.list-visit {
  min-width: 0;
}
/* 卡片内联评论沿用同一阅读区，但不再重复卡片底色与内距，避免卡片里套卡片。 */
.card-content :deep(.comment-section) {
  margin-top: 12px;
  padding: 0;
  background: transparent;
  border-top: 1px solid var(--line);
  border-radius: 0;
}
.card-content :deep(.comment-section > .comment-heading) {
  padding: 4px 0 0;
}
.list-notice {
  padding: 12px 0;
  margin: 0;
  color: var(--muted);
  font-size: var(--font-link);
  line-height: var(--line-link);
  overflow-wrap: anywhere;
}
.list-append {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0 24px;
}
.list-action {
  min-height: var(--touch);
}
</style>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ElButton } from 'element-plus';
import type { ArchiveMetadata, CommentSort } from '../data/contracts';
import type { CommentSnapshot, ReplySnapshot } from '../app/snapshots';
import { useArchiveNavigation } from '../app/navigation';
import { useSession } from '../app/session';
import type { ReadStatus } from '../data/contracts';
import { confirmedTarget, noticeStatus as readNoticeStatus } from './locate';
import { useCommentsRead } from './useCommentsRead';
import CommentItem from './CommentItem.vue';
import ReadNotice from './ReadNotice.vue';

const props = defineProps<{
  /** 区域身份：读取与交互状态按它隔离，同一页面可以挂载多个评论区域。 */
  regionId: string;
  dynamicId: string;
  authorId: string;
  sort: CommentSort;
  archive?: ArchiveMetadata;
  /** 宽屏才渲染内联回复区；窄屏回复入口由 07 交付。 */
  compact: boolean;
  initial: CommentSnapshot;
  /** 精确入口的目标一级评论；首批改走定位读取，成功后高亮并展开该条。 */
  anchorId?: string | null;
  /** 精确入口的目标回复：只交给所属根评论的回复区，根评论本身不高亮。 */
  locateReplyId?: string | null;
}>();
const emit = defineEmits<{ update: [CommentSnapshot]; settled: []; restart: [] }>();

const { reader } = useSession();
const navigation = useArchiveNavigation();
const { state, load, loadEarlier, earlierPending, earlierError } = useCommentsRead(
  reader,
  { regionId: props.regionId, dynamicId: props.dynamicId, sort: props.sort, anchorId: props.anchorId },
  props.initial.read);
const expanded = ref<Record<string, boolean>>({ ...props.initial.expanded });
// 只标记确实读到的目标：目标不在已读批次里绝不冒充定位成功。
// 回复精确入口只高亮目标回复，所属根评论只作上下文，不抢高亮。
const highlightId = computed(() => confirmedTarget(
  props.locateReplyId ? null : props.anchorId, state.value.data?.items));
const replies = ref<Record<string, ReplySnapshot>>({ ...props.initial.replies });
// 向前读取时的滚动锚点：取列表里第一个已渲染的评论，插入后按它的位移补回。
const listElement = ref<HTMLElement | null>(null);
const area = computed(() => props.sort === 'hot' ? '最热评论' : '最新评论');
// not-found 有自己的提示与返回入口，不交给通用读取失败提示。
const noticeStatus = computed<ReadStatus>(() => readNoticeStatus(state.value.status));
// 成功空只在归档确认本轮根评论同步完成后才是“暂无评论”，否则不冒充来源没有评论。
const emptyUnarchived = computed(() => Boolean(props.archive
  && (props.archive.rootCommentsLastAttempt ?? props.archive.work.comments) !== 'success'));

// 定位到的目标正文默认展开：折叠的正文必须可直接阅读。
watch(highlightId, id => {
  if (id && !expanded.value[id]) expanded.value = { ...expanded.value, [id]: true };
}, { immediate: true });

function toggle(id: string): void {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] };
}

function setReply(rootId: string, next: ReplySnapshot): void {
  replies.value = { ...replies.value, [rootId]: next };
}

/** 等待下一帧：插入后的布局（提示行、换行、字体）可能跨帧才稳定。 */
function nextFrame(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * 分帧收敛：反复把锚点的视口位置拉回插入前的位置，直到连续两帧稳定。
 * 浏览器原生滚动锚定可能已经补偿过，所以只补差额，不做整段高度搬移。
 */
async function holdPosition(anchor: HTMLElement, before: number): Promise<void> {
  let stable = 0;
  for (let pass = 0; pass < 20; pass += 1) {
    await nextTick();
    const delta = anchor.getBoundingClientRect().top - before;
    if (Math.abs(delta) <= 1) {
      stable += 1;
      if (stable >= 2) return;
    } else {
      stable = 0;
      if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
        window.scrollTo({ top: window.scrollY + delta, left: 0, behavior: 'instant' });
      }
    }
    await nextFrame();
  }
}

/** 向前读取一批更早评论，并把插入造成的位移补回滚动位置（视口内容不跳动）。 */
async function loadEarlierComments(): Promise<void> {
  // 基准取插入前列表里第一个已渲染的评论：它就在用户当前阅读位置，不依赖总文档高度。
  const anchor = listElement.value?.querySelector<HTMLElement>('[data-reading-id]') ?? null;
  const before = anchor?.getBoundingClientRect().top ?? 0;
  await loadEarlier();
  if (!anchor) return;
  await holdPosition(anchor, before);
}

watch([state, expanded, replies], () => {
  emit('update', {
    regionId: props.regionId,
    sort: props.sort, read: state.value, expanded: { ...expanded.value }, replies: { ...replies.value },
  });
}, { immediate: true, flush: 'sync' });
// 首批有结果（成功或失败）后通知入口定位：布局已稳定，迟到任务也不会反复拉回。
watch(() => state.value.status, status => {
  if (status !== 'loading') emit('settled');
}, { immediate: true, flush: 'post' });
</script>

<template>
  <section v-if="state.reason === 'invalid-cursor'" class="comment-status">
    <p role="alert">评论读取标记无效，请重新开始读取。</p>
    <el-button type="primary" link class="comment-action" @click="emit('restart')">重新开始读取</el-button>
  </section>
  <section v-if="state.status === 'not-found'" class="comment-status" aria-label="定位结果">
    <p role="status">目标评论不存在或未归档，无法定位到这条评论。</p>
    <el-button type="primary" link class="comment-action" @click="navigation.showDetail(dynamicId)">
      返回动态
    </el-button>
  </section>
  <p v-if="state.reason === 'not-archived'" class="comment-status" role="status">
    评论尚未归档；来源计数不代表本地已有评论。
  </p>
  <ReadNotice
    v-if="!state.data && state.reason !== 'invalid-cursor' && state.reason !== 'not-archived'"
    :status="noticeStatus"
    :area="area"
    @retry="load()"
  />
  <p v-if="state.data && state.data.items.length === 0" class="comment-status" role="status">
    {{ emptyUnarchived ? '评论尚未归档；来源计数不代表本地已有评论。' : '暂无评论' }}
  </p>
  <section v-if="state.data && (state.data.earlierCount ?? 0) > 0" class="comment-earlier" aria-label="更早评论">
    <p class="comment-earlier-count" role="status">以上还有 {{ state.data.earlierCount }} 条更早评论</p>
    <p v-if="earlierError" class="comment-earlier-error" role="alert">更早评论读取失败，请重试。</p>
    <el-button
      type="primary"
      class="comment-action"
      :disabled="earlierPending"
      @click="loadEarlierComments()"
    >{{ earlierPending ? '正在读取更早评论…' : '加载更早评论' }}</el-button>
  </section>
  <ul v-if="state.data && state.data.items.length > 0" ref="listElement" class="comment-list" aria-label="一级评论">
    <CommentItem
      v-for="item in state.data.items"
      :key="item.id"
      :comment="item"
      :author-id="authorId"
      :dynamic-id="dynamicId"
      :compact="compact"
      :expanded="expanded[item.id] ?? false"
      :reply="replies[item.id]"
      :highlight="highlightId === item.id"
      :locate-reply-id="locateReplyId && item.id === anchorId ? locateReplyId : null"
      @toggle="toggle(item.id)"
      @reply="setReply(item.id, $event)"
    />
  </ul>
  <section
    v-if="state.data && state.data.items.length > 0 && state.data.nextCursor !== null"
    class="comment-append"
    aria-label="评论追加"
  >
    <ReadNotice
      v-if="state.status !== 'success' && state.reason !== 'invalid-cursor'"
      :status="noticeStatus"
      :area="`${area}追加`"
      @retry="load()"
    />
    <el-button
      v-if="state.status === 'success' || state.status === 'loading'"
      type="primary"
      class="comment-action"
      :disabled="state.status === 'loading'"
      @click="load()"
    >加载更多评论</el-button>
  </section>
</template>

<style scoped>
.comment-status {
  padding: 12px 0;
  margin: 0;
  color: var(--muted);
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.comment-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.comment-append {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0 4px;
}
.comment-earlier {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px 0 8px;
}
.comment-earlier-count {
  margin: 0;
  color: var(--muted);
  line-height: 1.7;
}
.comment-earlier-error {
  margin: 0;
  color: var(--danger, #b3261e);
  line-height: 1.7;
}
.comment-action {
  min-height: var(--touch);
}
</style>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { ElButton } from 'element-plus';
import { replyPreviewSize } from '../data/contracts';
import type { ReadStatus, Reply } from '../data/contracts';
import type { ReplyReadState, ReplySnapshot } from '../app/snapshots';
import { useSession } from '../app/session';
import { useArchiveNavigation } from '../app/navigation';
import { useReplyPage } from './useReplyPage';
import { useReplyPreview } from './useReplyPreview';
import { confirmedTarget, noticeStatus as readNoticeStatus, targetMissing } from './locate';
import { useLocateTarget } from './useLocateTarget';
import { replyPageCount, replyPageSize } from './replyPaging';
import { alignFirstReply } from './pageScroll';
import { replyBodyText, replyTargetNickname } from './replyText';
import { displayTime } from './display';
import FoldableText from './FoldableText.vue';
import ReadNotice from './ReadNotice.vue';
import ReadOnlyLike from './ReadOnlyLike.vue';
import ReplyPager from './ReplyPager.vue';
import UserAvatar from './UserAvatar.vue';

const props = defineProps<{
  dynamicId: string;
  rootId: string;
  authorId: string;
  initial?: ReplySnapshot;
  /** 精确入口的目标回复：首读改为定位读取，展开所在页并高亮该条。 */
  locateReplyId?: string | null;
}>();
const emit = defineEmits<{ update: [ReplySnapshot] }>();

const { reader } = useSession();
const navigation = useArchiveNavigation();
const located = computed(() => props.locateReplyId ?? null);
// 历史恢复已有本回复区的快照（含页码）：按保存页码实时重读即可，
// 按目标身份重新定位只属于主动入口，恢复时不再重跑。
// 快照只在 setup 时存在才算恢复：本回复区自己的 update 回写也会让同一个 prop 变成已定义。
const restored = props.initial !== undefined;
const activeLocate = restored ? null : located.value;
// 定位进来的回复区没有读过预览：首个读取走定位，预览等收起时再按需读取。
const preview = useReplyPreview(
  reader, { dynamicId: props.dynamicId, rootId: props.rootId }, props.initial?.read,
  { auto: !located.value });
const expanded = ref(Boolean(located.value) || (props.initial?.expanded ?? false));
const expandedTexts = ref<Record<string, boolean>>({ ...props.initial?.expandedTexts });
// 已展开的历史恢复按保存页码实时重读；未展开时不启用页码读取。
// 精确入口新访问的首个请求是定位读取（页码由服务端给出），不先读第 1 页。
const live = useReplyPage(
  (page, signal) => reader.readReplies({
    dynamicId: props.dynamicId, rootId: props.rootId, page, limit: replyPageSize, signal,
  }),
  expanded.value && !activeLocate ? props.initial?.page ?? 1 : null,
  activeLocate
    ? signal => reader.locateReply({
      dynamicId: props.dynamicId, rootId: props.rootId, replyId: activeLocate, signal,
    })
    : undefined,
);

const state = computed<ReplyReadState>(() => {
  if (!expanded.value) return preview.state.value;
  // 展开第 1 页时先沿用预览内容，避免翻页闪烁；页码结果落下即替换，不累计。
  const current = live.state.value;
  return { ...current, data: current.data ?? (current.page === 1 ? preview.state.value.data : null) };
});
const invalidCursor = computed(() => state.value.reason === 'invalid-cursor');
// 只有确实读到目标才标记：目标不在当前页绝不冒充定位成功。
const highlightId = computed(() => confirmedTarget(located.value, live.state.value.data?.items));
// 目标不存在有自己的提示与返回入口，不交给通用读取失败提示。
const locateMissing = computed(() => targetMissing(located.value, live.state.value.status));
const noticeStatus = computed<ReadStatus>(() => readNoticeStatus(state.value.status));
const localTotal = computed(() => state.value.data?.count ?? state.value.data?.localReplyCount ?? null);
const pages = computed(() => replyPageCount(localTotal.value, state.value.data?.items.length ?? 0));
const currentPage = computed(() => Math.min(live.state.value.page, pages.value));
const visible = computed<readonly Reply[]>(() => {
  const items = state.value.data?.items ?? [];
  return expanded.value ? items : items.slice(0, replyPreviewSize);
});
const hasItems = computed(() => (state.value.data?.items.length ?? 0) > 0);
// 本地零条不等于来源没有回复：未完成/失败/未确认的归档单独表达，不冒充确认空。
const emptyNotice = computed<string>(() => {
  const attempt = state.value.data?.repliesLastAttempt;
  if (attempt === 'pending') return '回复尚未完成保存。';
  if (attempt === 'failed') return '回复最近保存失败。';
  if (attempt === 'unconfirmed') return '回复保存尚未确认完成。';
  return '暂无回复';
});
const canExpand = computed(() => !expanded.value && !invalidCursor.value
  && (state.value.data?.nextCursor ?? null) !== null);
const busy = computed(() => state.value.status === 'loading' || invalidCursor.value);
const section = ref<HTMLElement | null>(null);
const listId = useId();

/** 用户点分页器翻页：新页落下后把这一页的第一条带到视口顶部。 */
const alignPending = ref(false);
function selectPage(page: number): void {
  alignPending.value = true;
  void live.loadPage(page);
}
watch(() => state.value.status, status => {
  if (!alignPending.value || status === 'loading') return;
  alignPending.value = false;
  if (status === 'success') alignFirstReply(section.value);
}, { flush: 'post' });

function load(): void {
  if (!expanded.value) {
    void preview.load();
    return;
  }
  // 精确定位的显式重试：成功后仍把目标带回视口（用户自己点了重试，不算抢滚动）。
  if (located.value && !live.state.value.data) locate.arm();
  live.retry();
}

/** 展开：每次展开都重读第 1 页，不复用任何已读页结果。 */
function expand(): void {
  expanded.value = true;
  void live.loadPage(1);
}

/**
 * 收起：取消在途页码请求，记下 page 1，并在 DOM 收起后把所属根评论定位到开头。
 * 收起后的迟到成功/失败/完成回调因请求身份失效而不生效。
 */
async function collapse(): Promise<void> {
  live.cancel();
  expanded.value = false;
  await nextTick();
  section.value?.closest<HTMLElement>('[data-reading-id^="comment:"]')
    ?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
  // 精确定位进入时没读过预览：收起后按常规首屏读 3 条，不留下空白回复区。
  if (!preview.state.value.data) void preview.load();
}

/**
 * 精确定位：目标正文默认展开，并在 DOM 更新后把目标回复定位到视口。
 * 定位意图只消费一次；成功、失败与「不存在」都会落到目标回复或本区提示上。
 */
const locate = useLocateTarget({
  target: () => (highlightId.value
    ? section.value?.querySelector<HTMLElement>(
      `[data-reading-id="reply:${props.rootId}:${highlightId.value}"]`)
    : null),
  // 目标读不到时定位到本回复区的提示，绝不把楼层顶部当作定位结果。
  container: () => section.value,
  releaseOnUserScroll: true,
});
if (activeLocate) locate.arm();

// 目标的折叠正文在定位时直接展开，保证可直接阅读。
watch(highlightId, id => {
  if (id && !expandedTexts.value[id]) expandedTexts.value = { ...expandedTexts.value, [id]: true };
}, { immediate: true });
// 成功、不存在与失败都在布局稳定后处理一次，迟到结果不反复抢滚动。
watch(() => [highlightId.value, state.value.status], () => {
  if (state.value.status === 'loading') return;
  void locate.settle();
}, { flush: 'post' });

/** 失效 cursor：丢弃预览与页码状态，重新从首批 3 条开始读取。 */
function restart(): void {
  live.cancel();
  expanded.value = false;
  expandedTexts.value = {};
  preview.restart();
}

function toggleText(id: string): void {
  expandedTexts.value = { ...expandedTexts.value, [id]: !expandedTexts.value[id] };
}

/** 仅嵌套回复且目标昵称可用时表达目标；直接回根不重复。 */
function targetNickname(reply: Reply): string | null {
  return replyTargetNickname(reply, props.rootId);
}

function bodyText(reply: Reply): string {
  const text = replyBodyText(reply.text);
  return text.trim() ? text : '暂无评论内容';
}

watch([() => preview.state.value, expanded, () => live.state.value.page, expandedTexts], () => {
  const next: ReplySnapshot = {
    read: preview.state.value,
    expanded: expanded.value,
    // 收起统一保存第 1 页，再次展开重新首读。
    page: expanded.value ? live.state.value.page : 1,
    expandedTexts: { ...expandedTexts.value },
  };
  emit('update', next);
}, { immediate: true, flush: 'sync' });
</script>

<template>
  <section ref="section" class="reply-section" aria-label="回复区">
    <section v-if="invalidCursor" class="reply-status">
      <p role="alert">回复读取标记无效，请重新开始读取。</p>
      <el-button type="primary" link class="reply-action" @click="restart">重新开始读取</el-button>
    </section>
    <section v-if="locateMissing" class="reply-status" aria-label="定位结果">
      <p role="status">目标回复不存在或未保存，无法定位到这条回复。</p>
      <el-button type="primary" link class="reply-action" @click="navigation.showDetail(dynamicId)">
        返回动态
      </el-button>
    </section>
    <ReadNotice
      v-if="!state.data && !invalidCursor && !locateMissing"
      :status="noticeStatus"
      area="回复"
      @retry="load"
    />
    <p v-if="state.data && !hasItems && !invalidCursor" class="reply-status" role="status">{{ emptyNotice }}</p>
    <ul v-if="visible.length > 0" :id="listId" class="reply-list" aria-label="回复列表">
      <li
        v-for="item in visible"
        :key="item.id"
        class="reply"
        :class="{ 'reply--target': highlightId === item.id }"
        :data-reading-id="`reply:${rootId}:${item.id}`"
        :data-located="highlightId === item.id ? 'true' : undefined"
        :aria-current="highlightId === item.id ? 'true' : undefined"
      >
        <div class="reply__identity">
          <UserAvatar :user="item.author" :size="24" class="reply__avatar" />
          <span class="reply__nickname">{{ item.author.nickname ?? '未知用户' }}</span>
          <span v-if="item.author.id === authorId" class="reply__badge">UP主</span>
        </div>
        <FoldableText
          :text="bodyText(item)"
          subject="回复正文"
          :expanded="expandedTexts[item.id] ?? false"
          @toggle="toggleText(item.id)"
        >
          <template v-if="targetNickname(item)" #prefix>
            <span class="reply__target">回复 {{ targetNickname(item) }}:</span>
          </template>
        </FoldableText>
        <div class="reply__metrics">
          <time class="reply__time" :datetime="item.publishedAt ?? undefined">
            {{ displayTime(item.publishedAt) }}
          </time>
          <ReadOnlyLike :count="item.likeCount" />
        </div>
      </li>
    </ul>
    <ReadNotice
      v-if="state.data && hasItems && state.status !== 'success' && state.status !== 'loading' && !invalidCursor"
      :status="noticeStatus"
      area="回复"
      @retry="load"
    />
    <el-button
      v-if="canExpand"
      type="primary"
      link
      class="reply-action reply-expand"
      aria-expanded="false"
      :aria-controls="listId"
      :disabled="state.status === 'loading'"
      @click="expand"
    >展开回复</el-button>
    <ReplyPager
      v-if="expanded && hasItems"
      :page="currentPage"
      :pages="pages"
      :busy="busy"
      @select="selectPage"
    />
    <!-- 收起是区域动作而非翻页：从分页器里移出来，展开后单独提供。 -->
    <el-button
      v-if="expanded && hasItems"
      type="primary"
      link
      class="reply-action reply-collapse"
      aria-expanded="true"
      :aria-controls="listId"
      @click="collapse"
    >收起</el-button>
  </section>
</template>

<style scoped>
.reply-section {
  min-width: 0;
  padding: 4px 0 0 12px;
  border-left: 2px solid var(--line);
}
.reply-status {
  padding: 4px 0;
  margin: 0;
  color: var(--muted);
  font-size: var(--font-meta);
  line-height: var(--line-meta);
  overflow-wrap: anywhere;
}
.reply-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.reply {
  min-width: 0;
  padding: 8px 0;
  border-top: 1px solid var(--line);
}
.reply:first-child {
  border-top: 0;
}
/* 精确定位的一次性标记：定位完成后保持可见，但不再改变滚动位置。 */
.reply--target {
  background: var(--brand-soft);
  border-radius: var(--radius);
  box-shadow: inset 3px 0 0 var(--brand);
  outline: 1px solid var(--brand);
  outline-offset: 2px;
}
.reply__identity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.reply__avatar {
  flex: 0 0 24px;
}
.reply__nickname {
  color: var(--author);
  font-size: var(--font-comment-author);
  line-height: var(--line-comment-author);
  font-weight: 600;
  overflow-wrap: anywhere;
}
.reply__badge {
  padding: 0 6px;
  border-radius: 999px;
  background: #fdebf3;
  color: var(--author);
  font-size: var(--font-badge);
  line-height: var(--line-badge);
  white-space: nowrap;
}
.reply__target {
  color: var(--brand-strong);
}
.reply :deep(.text) {
  margin: 4px 0;
  font-size: var(--font-comment);
  line-height: var(--line-comment);
}
.reply__metrics {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  color: var(--muted);
  font-size: var(--font-meta);
  line-height: var(--line-meta);
  font-variant-numeric: tabular-nums;
}
.reply__time {
  overflow-wrap: anywhere;
}
.reply-action {
  min-height: var(--touch);
  font-size: var(--font-link);
  line-height: var(--line-link);
}
</style>

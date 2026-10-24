<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { ElButton } from 'element-plus';
import { replyPreviewSize } from '../data/contracts';
import type { Reply } from '../data/contracts';
import type { ReplyReadState, ReplySnapshot } from '../app/snapshots';
import { useSession } from '../app/session';
import { useReplyPage } from './useReplyPage';
import { useReplyPreview } from './useReplyPreview';
import { replyPageCount, replyPageSize } from './replyPaging';
import { replyBodyText } from './replyText';
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
}>();
const emit = defineEmits<{ update: [ReplySnapshot] }>();

const { reader } = useSession();
const preview = useReplyPreview(
  reader, { dynamicId: props.dynamicId, rootId: props.rootId }, props.initial?.read);
const expanded = ref(props.initial?.expanded ?? false);
const expandedTexts = ref<Record<string, boolean>>({ ...props.initial?.expandedTexts });
// 已展开的历史恢复按保存页码实时重读；未展开时不启用页码读取。
const live = useReplyPage(
  (page, signal) => reader.readReplies({
    dynamicId: props.dynamicId, rootId: props.rootId, page, limit: replyPageSize, signal,
  }),
  expanded.value ? props.initial?.page ?? 1 : null,
);

const state = computed<ReplyReadState>(() => {
  if (!expanded.value) return preview.state.value;
  // 展开第 1 页时先沿用预览内容，避免翻页闪烁；页码结果落下即替换，不累计。
  const current = live.state.value;
  return { ...current, data: current.data ?? (current.page === 1 ? preview.state.value.data : null) };
});
const invalidCursor = computed(() => state.value.reason === 'invalid-cursor');
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
  if (attempt === 'pending') return '回复尚未完成归档。';
  if (attempt === 'failed') return '回复最近归档失败。';
  if (attempt === 'unconfirmed') return '回复归档尚未确认完成。';
  return '暂无回复';
});
const canExpand = computed(() => !expanded.value && !invalidCursor.value
  && (state.value.data?.nextCursor ?? null) !== null);
const busy = computed(() => state.value.status === 'loading' || invalidCursor.value);
const section = ref<HTMLElement | null>(null);
const listId = useId();

function load(): void {
  if (expanded.value) live.retry();
  else void preview.load();
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
}

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
  if (!reply.parentId || reply.parentId === props.rootId) return null;
  return reply.replyTo?.nickname ?? null;
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
    <ReadNotice
      v-if="!state.data && !invalidCursor"
      :status="state.status"
      area="回复"
      @retry="load"
    />
    <p v-if="state.data && !hasItems && !invalidCursor" class="reply-status" role="status">{{ emptyNotice }}</p>
    <ul v-if="visible.length > 0" :id="listId" class="reply-list" aria-label="回复列表">
      <li
        v-for="item in visible"
        :key="item.id"
        class="reply"
        :data-reading-id="`reply:${rootId}:${item.id}`"
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
      v-if="state.data && hasItems && state.status !== 'success' && !invalidCursor"
      :status="state.status"
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
      @select="live.loadPage($event)"
      @collapse="collapse"
    />
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
  font-size: 13px;
  line-height: 22px;
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
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.reply__badge {
  padding: 0 6px;
  border-radius: 999px;
  background: #fdebf3;
  color: var(--author);
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
}
.reply__target {
  color: var(--brand-strong);
}
.reply :deep(.text) {
  margin: 4px 0;
  font-size: 15px;
  line-height: 24px;
}
.reply__metrics {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  color: var(--muted);
  font-size: 13px;
  line-height: 22px;
}
.reply__time {
  overflow-wrap: anywhere;
}
.reply-action {
  min-height: var(--touch);
  font-size: 13px;
}
</style>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElButton } from 'element-plus';
import type { Comment, ReadStatus, Reply } from '../data/contracts';
import { useArchiveNavigation } from '../app/navigation';
import { useSession } from '../app/session';
import { displayTime } from '../dynamics/display';
import { confirmedTarget, noticeStatus as readNoticeStatus, targetMissing } from '../dynamics/locate';
import { useLocateTarget } from '../dynamics/useLocateTarget';
import { replyBodyText, replyTargetNickname } from '../dynamics/replyText';
import { replyPageCount, replyPageSize } from '../dynamics/replyPaging';
import { useReplyPage } from '../dynamics/useReplyPage';
import { useThreadAuthor } from '../dynamics/useThreadAuthor';
import ReadNotice from '../dynamics/ReadNotice.vue';
import ReadOnlyLike from '../dynamics/ReadOnlyLike.vue';
import ReplyPager from '../dynamics/ReplyPager.vue';
import UserAvatar from '../dynamics/UserAvatar.vue';

const props = defineProps<{ dynamicId: string; rootId: string; replyId?: string | null }>();

const { reader } = useSession();
const navigation = useArchiveNavigation();
// 楼中楼没有自己的阅读快照：每次重新挂载都从第 1 页实时读取，并回到页面顶部。
// 回复精确入口首个读取改为按目标身份定位，直接显示目标所在页而不是第 1 页。
const located = computed(() => props.replyId ?? null);
const { state, loadPage, retry } = useReplyPage(
  (page, signal) => reader.readReplies({
    dynamicId: props.dynamicId, rootId: props.rootId, page, limit: replyPageSize, signal,
  }),
  located.value ? null : 1,
  located.value
    ? signal => reader.locateReply({
      dynamicId: props.dynamicId, rootId: props.rootId, replyId: located.value!, signal,
    })
    : undefined,
);
const { authorId } = useThreadAuthor(reader, props.dynamicId);

const container = ref<HTMLElement | null>(null);
// 只有确实读到目标才标记：目标不在当前页绝不冒充定位成功。
const highlightId = computed(() => confirmedTarget(located.value, state.value.data?.items));
const locateMissing = computed(() => targetMissing(located.value, state.value.status));
const noticeStatus = computed<ReadStatus>(() => readNoticeStatus(state.value.status));

/** 精确入口把目标回复定位到视口；结果只消费一次，不反复抢滚动。 */
const locate = useLocateTarget({
  target: () => (highlightId.value
    ? container.value?.querySelector<HTMLElement>(
      `[data-reading-id="reply:${props.rootId}:${highlightId.value}"]`)
    : null),
  container: () => container.value,
});
if (located.value) locate.arm();

onMounted(() => {
  // 精确定位自己决定落点，不先回到页面顶部再找目标。
  if (!located.value) window.scrollTo?.({ top: 0 });
});

const rootComment = computed<Comment | null>(() => state.value.data?.root ?? null);
const items = computed<readonly Reply[]>(() => state.value.data?.items ?? []);
/** 页头数量：来源总数 → 本页本地 count → 已读条数。 */
const total = computed(() => state.value.data?.sourceReplyCount
  ?? state.value.data?.count ?? items.value.length);
/** 分页只用本地回复量；来源总数不参与末页判断。 */
const localCount = computed(() => state.value.data?.localReplyCount
  ?? state.value.data?.count ?? items.value.length);
const pages = computed(() => replyPageCount(
  state.value.data?.count ?? state.value.data?.localReplyCount ?? null, items.value.length));
const currentPage = computed(() => Math.min(state.value.page, pages.value));
// 只有来源与本地都有确定数量时才说明差额；缺字段不编造“已保存 x/y”。
const unreturned = computed(() => {
  const source = state.value.data?.sourceReplyCount;
  const local = state.value.data?.localReplyCount;
  return typeof source === 'number' && typeof local === 'number' && source > local ? source - local : 0;
});
const invalidCursor = computed(() => state.value.reason === 'invalid-cursor');
const busy = computed(() => state.value.status === 'loading' || invalidCursor.value);
const heading = computed(() => `相关回复共${total.value}条`);

// 定位结果落下（成功/不存在/失败）后处理一次，布局稳定后再落点。
watch(highlightId, () => { void locate.settle(); }, { flush: 'post' });
watch(() => state.value.status, status => {
  if (status !== 'loading') void locate.settle();
}, { flush: 'post' });

function restart(): void {
  void loadPage(1);
}

/** 读取提示上的显式重试：定位未成功时重发定位，成功后仍把目标带回视口。 */
function retryRead(): void {
  if (located.value && !state.value.data) locate.arm();
  retry();
}

function back(): void {
  navigation.returnFromThread(props.dynamicId);
}

/** 仅嵌套回复且目标昵称可用时表达目标；直接回根不重复。 */
function targetNickname(reply: Reply): string | null {
  return replyTargetNickname(reply, props.rootId);
}

function bodyText(reply: Reply): string {
  const text = replyBodyText(reply.text);
  return text.trim() ? text : '暂无评论内容';
}

function rootText(comment: Comment): string {
  return comment.text.trim() || '暂无评论内容';
}
</script>

<template>
  <div ref="container" class="thread-visit">
    <el-button class="thread-back" text aria-label="返回评论" @click="back">‹ 评论详情</el-button>
    <section v-if="invalidCursor" class="thread-status">
      <p role="alert">回复读取标记无效，请重新开始读取。</p>
      <el-button type="primary" link class="thread-action" @click="restart">重新开始读取</el-button>
    </section>
    <section v-if="locateMissing" class="thread-status" aria-label="定位结果">
      <p role="status">目标回复不存在或未保存，无法定位到这条回复。</p>
      <el-button type="primary" link class="thread-action" @click="navigation.showDetail(dynamicId)">
        返回动态
      </el-button>
    </section>
    <ReadNotice
      v-if="!state.data && !invalidCursor && !locateMissing"
      :status="noticeStatus"
      area="相关回复"
      @retry="retryRead"
    />
    <template v-if="state.data">
      <article v-if="rootComment" class="thread-root" aria-label="被回复的评论">
        <div class="thread-root__identity">
          <UserAvatar :user="rootComment.author" :size="40" class="thread-avatar" />
          <span class="thread-nickname">{{ rootComment.author.nickname ?? '未知用户' }}</span>
          <span v-if="rootComment.author.id === authorId" class="thread-badge thread-badge--up">UP主</span>
          <span v-if="rootComment.isPinned" class="thread-badge">置顶</span>
        </div>
        <p class="thread-root__text">{{ rootText(rootComment) }}</p>
        <div class="thread-metrics">
          <time class="thread-time" :datetime="rootComment.publishedAt ?? undefined">
            {{ displayTime(rootComment.publishedAt) }}
          </time>
          <ReadOnlyLike :count="rootComment.likeCount" />
        </div>
      </article>
      <header class="thread-heading">
        <h1>{{ heading }}</h1>
        <span class="thread-order">按时间</span>
      </header>
      <p v-if="unreturned > 0" class="thread-status" role="status">
        已保存 {{ localCount }}/{{ total }}，上游另有 {{ unreturned }} 条回复未返回。
      </p>
      <ul v-if="items.length > 0" class="thread-list" aria-label="相关回复">
        <li
          v-for="item in items"
          :key="item.id"
          class="thread-reply"
          :class="{ 'thread-reply--target': highlightId === item.id }"
          :data-reading-id="`reply:${rootId}:${item.id}`"
          :data-located="highlightId === item.id ? 'true' : undefined"
          :aria-current="highlightId === item.id ? 'true' : undefined"
        >
          <div class="thread-reply__identity">
            <UserAvatar :user="item.author" :size="24" class="thread-avatar" />
            <span class="thread-nickname">{{ item.author.nickname ?? '未知用户' }}</span>
            <span v-if="item.author.id === authorId" class="thread-badge thread-badge--up">UP主</span>
          </div>
          <p class="thread-reply__text">
            <span v-if="targetNickname(item)" class="thread-reply__target">回复 {{ targetNickname(item) }}:</span>{{ bodyText(item) }}
          </p>
          <div class="thread-metrics">
            <time class="thread-time" :datetime="item.publishedAt ?? undefined">
              {{ displayTime(item.publishedAt) }}
            </time>
            <ReadOnlyLike :count="item.likeCount" />
          </div>
        </li>
      </ul>
      <p v-else class="thread-status" role="status">暂无回复</p>
      <ReadNotice
        v-if="state.status !== 'success' && !invalidCursor"
        :status="noticeStatus"
        area="相关回复追加"
        @retry="retryRead"
      />
      <ReplyPager
        v-if="total > 0"
        :page="currentPage"
        :pages="pages"
        :busy="busy"
        @select="loadPage"
        @collapse="back"
      />
    </template>
  </div>
</template>

<style scoped>
.thread-visit {
  width: 100%;
  max-width: var(--column-max);
  min-width: 0;
  margin: 0 auto;
  padding: 0 0 40px;
}
/* 回复详情的返回控件：与普通阅读返回链接同为 14/22、常规字重、44px 点击区。 */
.thread-back {
  min-height: var(--touch);
  padding: 0 4px;
  color: var(--action);
  font-size: var(--font-link);
  font-weight: 400;
  line-height: var(--line-link);
}
.thread-root {
  min-width: 0;
  padding: 16px;
  background: var(--card-bg);
  border-radius: var(--radius);
}
.thread-root__identity,
.thread-reply__identity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.thread-avatar {
  flex: 0 0 auto;
}
.thread-nickname {
  color: var(--author);
  font-size: var(--font-comment-author);
  line-height: var(--line-comment-author);
  font-weight: 600;
  overflow-wrap: anywhere;
}
.thread-badge {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--brand-soft, #e6f6f7);
  color: var(--brand-strong);
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
}
.thread-badge--up {
  background: #fdebf3;
  color: var(--author);
}
.thread-root__text,
.thread-reply__text {
  margin: 6px 0;
  font-size: var(--font-comment);
  line-height: var(--line-comment);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.thread-reply__target {
  color: var(--brand-strong);
}
.thread-metrics {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  color: var(--muted);
  font-size: var(--font-meta);
  line-height: var(--line-meta);
  font-variant-numeric: tabular-nums;
}
.thread-time {
  overflow-wrap: anywhere;
}
.thread-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 16px 4px 4px;
}
.thread-heading h1 {
  margin: 0;
  font-size: var(--font-section);
  line-height: var(--line-section);
  font-weight: 500;
}
.thread-order {
  color: var(--muted);
  font-size: var(--font-meta);
  line-height: var(--line-meta);
}
.thread-status {
  padding: 8px 4px;
  margin: 0;
  color: var(--muted);
  font-size: var(--font-meta);
  line-height: var(--line-meta);
  overflow-wrap: anywhere;
}
.thread-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.thread-reply {
  min-width: 0;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
}
.thread-reply:first-child {
  border-top: 0;
}
/* 精确定位的一次性标记：定位完成后保持可见，但不再改变滚动位置。 */
.thread-reply--target {
  background: var(--brand-soft, #e6f6f7);
  border-radius: var(--radius);
  box-shadow: inset 3px 0 0 var(--brand);
  outline: 1px solid var(--brand);
  outline-offset: 2px;
}
.thread-reply__text {
  font-size: var(--font-comment);
  line-height: var(--line-comment);
}
.thread-action {
  min-height: var(--touch);
  font-size: var(--font-link);
  line-height: var(--line-link);
}
</style>

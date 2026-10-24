<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { ElButton } from 'element-plus';
import type { Comment, Reply } from '../data/contracts';
import { useArchiveNavigation } from '../app/navigation';
import { useSession } from '../app/session';
import { displayTime } from '../dynamics/display';
import { replyBodyText, replyTargetNickname } from '../dynamics/replyText';
import { replyPageCount, replyPageSize } from '../dynamics/replyPaging';
import { useReplyPage } from '../dynamics/useReplyPage';
import { useThreadAuthor } from '../dynamics/useThreadAuthor';
import ReadNotice from '../dynamics/ReadNotice.vue';
import ReadOnlyLike from '../dynamics/ReadOnlyLike.vue';
import ReplyPager from '../dynamics/ReplyPager.vue';
import UserAvatar from '../dynamics/UserAvatar.vue';

const props = defineProps<{ dynamicId: string; rootId: string }>();

const { reader } = useSession();
const navigation = useArchiveNavigation();
// 楼中楼没有自己的阅读快照：每次重新挂载都从第 1 页实时读取，并回到页面顶部。
const { state, loadPage, retry } = useReplyPage(
  (page, signal) => reader.readReplies({
    dynamicId: props.dynamicId, rootId: props.rootId, page, limit: replyPageSize, signal,
  }),
  1,
);
const { authorId } = useThreadAuthor(reader, props.dynamicId);

onMounted(() => { window.scrollTo?.({ top: 0 }); });

const root = computed<Comment | null>(() => state.value.data?.root ?? null);
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
// 只有来源与本地都有确定数量时才说明差额；缺字段不编造“已归档 x/y”。
const unreturned = computed(() => {
  const source = state.value.data?.sourceReplyCount;
  const local = state.value.data?.localReplyCount;
  return typeof source === 'number' && typeof local === 'number' && source > local ? source - local : 0;
});
const invalidCursor = computed(() => state.value.reason === 'invalid-cursor');
const busy = computed(() => state.value.status === 'loading' || invalidCursor.value);
const heading = computed(() => `相关回复共${total.value}条`);

function restart(): void {
  void loadPage(1);
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
  <div class="thread-visit">
    <el-button class="thread-back" text aria-label="返回评论" @click="back">‹ 评论详情</el-button>
    <section v-if="invalidCursor" class="thread-status">
      <p role="alert">回复读取标记无效，请重新开始读取。</p>
      <el-button type="primary" link class="thread-action" @click="restart">重新开始读取</el-button>
    </section>
    <ReadNotice
      v-if="!state.data && !invalidCursor"
      :status="state.status"
      area="相关回复"
      @retry="retry"
    />
    <template v-if="state.data">
      <article v-if="root" class="thread-root" aria-label="被回复的评论">
        <div class="thread-root__identity">
          <UserAvatar :user="root.author" :size="40" class="thread-avatar" />
          <span class="thread-nickname">{{ root.author.nickname ?? '未知用户' }}</span>
          <span v-if="root.author.id === authorId" class="thread-badge thread-badge--up">UP主</span>
          <span v-if="root.isPinned" class="thread-badge">置顶</span>
        </div>
        <p class="thread-root__text">{{ rootText(root) }}</p>
        <div class="thread-metrics">
          <time class="thread-time" :datetime="root.publishedAt ?? undefined">
            {{ displayTime(root.publishedAt) }}
          </time>
          <ReadOnlyLike :count="root.likeCount" />
        </div>
      </article>
      <header class="thread-heading">
        <h1>{{ heading }}</h1>
        <span class="thread-order">按时间</span>
      </header>
      <p v-if="unreturned > 0" class="thread-status" role="status">
        已归档 {{ localCount }}/{{ total }}，上游另有 {{ unreturned }} 条回复未返回。
      </p>
      <ul v-if="items.length > 0" class="thread-list" aria-label="相关回复">
        <li
          v-for="item in items"
          :key="item.id"
          class="thread-reply"
          :data-reading-id="`reply:${rootId}:${item.id}`"
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
        :status="state.status"
        area="相关回复追加"
        @retry="retry"
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
  max-width: 724px;
  min-width: 0;
  margin: 0 auto;
  padding: 0 0 40px;
}
.thread-back {
  min-height: var(--touch);
  padding: 0 4px;
  color: var(--brand-strong);
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
  font-size: 13px;
  line-height: 18px;
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
  font-size: 15px;
  line-height: 24px;
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
  font-size: 13px;
  line-height: 22px;
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
  font-size: 17px;
  line-height: 24px;
}
.thread-order {
  color: var(--muted);
  font-size: 13px;
}
.thread-status {
  padding: 8px 4px;
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 22px;
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
.thread-reply__text {
  font-size: 15px;
}
.thread-action {
  min-height: var(--touch);
}
</style>

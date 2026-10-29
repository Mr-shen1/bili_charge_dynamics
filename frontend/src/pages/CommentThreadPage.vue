<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElButton } from 'element-plus';
import type { Comment, ReadStatus, Reply, ReplySort } from '../data/contracts';
import { useArchiveNavigation } from '../app/navigation';
import { captureReadingPosition, restoreReadingPosition } from '../app/readingPosition';
import { adoptReplyVisitSnapshot, replyVisitRegion } from '../app/snapshots';
import { useCompactViewport } from '../app/useCompactViewport';
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
import SortToggle from '../dynamics/SortToggle.vue';
import UserAvatar from '../dynamics/UserAvatar.vue';

const props = defineProps<{ dynamicId: string; rootId: string; replyId?: string | null }>();

const { reader } = useSession();
const navigation = useArchiveNavigation();
// 会话列表只在手机回复详情提供；桌面保留列表内/详情内的回复阅读，不新增会话入口。
const compact = useCompactViewport();
// 访问身份在 setup 时固定：卸载时仍按本次访问保存，不受已经切换的路由影响。
const pageEntryId = navigation.pageEntryId;
// 回复访问的区域身份（动态 + 根评论）：另一根、另一动态或另一次访问的快照都不采纳。
const regionId = replyVisitRegion(props.dynamicId, props.rootId);
// 会话来源返回、浏览器返回与前进都恢复那一次访问：排序、页码、内容与位置一起回来，
// 因此不会只恢复坐标却先显示第 1 页。新访问（直达/刷新/新入口）没有快照。
const restored = adoptReplyVisitSnapshot(navigation.replyVisitSnapshot, regionId);
// 回复精确入口首个读取按目标身份定位，直接显示目标所在页而不是第 1 页；恢复时不再重新定位。
const located = computed(() => props.replyId ?? null);
// 手机回复详情默认按时间（旧到新），单按钮切到热度；与一级评论排序各自独立。
const sort = ref<ReplySort>(restored?.sort ?? 'time');
const { state, loadPage, retry } = useReplyPage(
  (page, signal) => reader.readReplies({
    dynamicId: props.dynamicId, rootId: props.rootId, page, limit: replyPageSize,
    sort: sort.value, signal,
  }),
  restored ? restored.read.page : located.value ? null : 1,
  // 定位读取只用于首次读取与显式重试；恢复的访问不会自动重跑，但重试仍按目标身份定位。
  located.value
    ? signal => reader.locateReply({
      dynamicId: props.dynamicId, rootId: props.rootId, replyId: located.value!, signal,
    })
    : undefined,
  restored?.read ?? null,
);
const { authorId } = useThreadAuthor(reader, props.dynamicId);

const container = ref<HTMLElement | null>(null);
/** 通知主动直达的时间序定位只属于本次访问：切换排序后不再用旧定位冒充新排序的页。 */
const locating = ref(restored ? restored.locating : Boolean(located.value));
// 只有确实读到目标才标记：目标不在当前页绝不冒充定位成功。
const highlightId = computed(() => (locating.value
  ? confirmedTarget(located.value, state.value.data?.items) : null));
const locateMissing = computed(() => locating.value
  && targetMissing(located.value, state.value.status));
const noticeStatus = computed<ReadStatus>(() => readNoticeStatus(state.value.status));

/** 精确入口把目标回复定位到视口；结果只消费一次，不反复抢滚动。 */
const locate = useLocateTarget({
  target: () => (highlightId.value
    ? container.value?.querySelector<HTMLElement>(
      `[data-reading-id="reply:${props.rootId}:${highlightId.value}"]`)
    : null),
  container: () => container.value,
});
/** 恢复快照时不再执行主动定位：那一次访问的定位结果与位置已经保存。 */
if (located.value && !restored) locate.arm();

let stopRestoring: () => void = () => undefined;

onMounted(() => {
  // 恢复的访问按保存的锚点与位置落点，不先回到页面顶部。
  if (restored) {
    stopRestoring = restoreReadingPosition(container.value, restored.position);
    return;
  }
  // 精确定位自己决定落点，不先回到页面顶部再找目标。
  if (!located.value) window.scrollTo?.({ top: 0 });
});

// 离开这次访问（会话、返回、前进后退）时保存排序、页码、定位意图、内容与位置：
// 会话返回与历史恢复都用这份短期快照，不重新定位、不退回第 1 页。
onBeforeUnmount(() => {
  stopRestoring();
  navigation.saveReplyVisitSnapshot(pageEntryId, {
    regionId,
    sort: sort.value,
    locating: locating.value,
    position: captureReadingPosition(container.value),
    // 直接持有当前的读取结果对象：`useReplyPage` 只整对象替换、不原地修改，
    // 快照不会被后续读取改写，也不需要再复制一份。
    read: state.value,
  });
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
// 数量只在读到本页时才声明：加载/失败期间不拿旧排序或旧页的计数冒充。
const heading = computed(() => (state.value.data ? `相关回复共${total.value}条` : '相关回复'));

// 定位结果落下（成功/不存在/失败）后处理一次，布局稳定后再落点。
watch(highlightId, () => { void locate.settle(); }, { flush: 'post' });
watch(() => state.value.status, status => {
  if (status !== 'loading') void locate.settle();
}, { flush: 'post' });

function restart(): void {
  void loadPage(1);
}

/**
 * 单击当前排序切到另一种：回到第 1 页并丢弃旧排序内容，重新读目标排序首批。
 * 定位意图随之作废：通知直达的页码是时间序的，不能当作热度页重复使用。
 */
function toggleSort(): void {
  sort.value = sort.value === 'time' ? 'hot' : 'time';
  locating.value = false;
  void loadPage(1, { clear: true });
}

/** 读取提示上的显式重试：定位未成功时重发定位，成功后仍把目标带回视口。 */
function retryRead(): void {
  if (locating.value && !state.value.data) locate.arm();
  retry();
}

function back(): void {
  navigation.returnFromThread(props.dynamicId);
}

/**
 * 入口资格只看服务端投影：至少两条可确认关联，且当前条不是对话起点。
 * 与当前页、排序无关；缺少投影（旧响应、cursor 预览）时不出入口，也不按昵称推断。
 */
function conversationOf(reply: Reply) {
  const conversation = reply.conversation;
  return compact.value && conversation && conversation.count >= 2 && conversation.startId !== reply.id
    ? conversation : null;
}

function openConversation(reply: Reply): void {
  navigation.openConversation(props.dynamicId, props.rootId, reply.id);
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
    <el-button class="thread-back" text aria-label="评论详情，返回动态详情" @click="back">‹ 评论详情</el-button>
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
      <!-- 排序控件只在手机回复详情提供：桌面内联楼中楼保留原时间序，不增加控件。 -->
      <SortToggle
        v-if="compact"
        class="thread-sort"
        :hot="sort === 'hot'"
        @toggle="toggleSort"
      />
    </header>
    <template v-if="state.data">
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
            <el-button
              v-if="conversationOf(item)"
              link
              class="thread-conversation"
              @click="openConversation(item)"
            >查看对话</el-button>
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
/* 共用标尺在 theme/reading.css：返回控件、回复条目、状态行与操作链接。 */
.thread-root {
  min-width: 0;
  padding: 16px;
  background: var(--card-bg);
  border-radius: var(--radius);
}
.thread-badge {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--brand-soft);
  color: var(--brand-strong);
  /* 徽标/UP 主标识 12/20：与阅读标尺的 badge 角色同一 token。 */
  font-size: var(--font-badge);
  line-height: var(--line-badge);
  white-space: nowrap;
}
.thread-badge--up {
  background: #fdebf3;
  color: var(--author);
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
  /* 回复数量标题 13/20、常规字重：小于动态正文，与右侧排序同级（设计 §4／§6）。 */
  font-size: var(--font-meta);
  line-height: var(--line-meta);
  font-weight: 400;
}
/* 精确定位的一次性标记：定位完成后保持可见，但不再改变滚动位置。 */
.thread-reply--target {
  background: var(--brand-soft);
  border-radius: var(--radius);
  box-shadow: inset 3px 0 0 var(--brand);
  outline: 1px solid var(--brand);
  outline-offset: 2px;
}
/* 查看对话与其它阅读链接同一层级：14px 常规字重，点击区不小于 44px。 */
.thread-conversation {
  min-height: var(--touch);
  padding: 0 4px;
  font-size: var(--font-link);
  line-height: var(--line-link);
  font-weight: 400;
  color: var(--action);
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElButton } from 'element-plus';
import type { ReadStatus, Reply } from '../data/contracts';
import type { ReadingPosition } from '../app/snapshots';
import { centerReadingAnchor, restoreReadingPosition } from '../app/readingPosition';
import { useSession } from '../app/session';
import { displayTime } from './display';
import { noticeStatus as readNoticeStatus } from './locate';
import { replyBodyText, replyTargetNickname } from './replyText';
import { useReplyPage } from './useReplyPage';
import ReadNotice from './ReadNotice.vue';
import ReadOnlyLike from './ReadOnlyLike.vue';
import UserAvatar from './UserAvatar.vue';

/**
 * 一段对话的只读内容视图：一次请求读完整个本地可确认集合，按时间正序整段展示，
 * 没有分页控件也不循环拼页。一级评论只作上下文不重复展示。
 *
 * 两种承载共用它：手机是独立整页（`ConversationPage`，文档滚动），桌面是弹窗
 * （`ConversationDialog`，内部滚动容器）。落点语义也共用一处：
 * 入口回复标“刚才查看”并在新打开时一次性定位——能居中就居中，位置夹在滚动源的
 * 真实可滚动范围内，不补留白（短会话/末条不留空白带）；给了 `restore` 则改成恢复位置。
 */
const props = withDefaults(defineProps<{
  dynamicId: string;
  rootId: string;
  replyId: string;
  /** 自己的滚动容器；不传就按整页文档滚动。 */
  scroller?: HTMLElement | null;
  /** 同一访问再次打开时恢复的阅读位置；为空表示这次是新打开，要做一次性定位。 */
  restore?: ReadingPosition | null;
  /** 目标不存在时的离开文案。 */
  leaveLabel?: string;
}>(), { scroller: null, restore: null, leaveLabel: '返回评论详情' });
const emit = defineEmits<{ leave: [] }>();

const { reader } = useSession();
// 整段读取复用同一套读取状态机（加载／失败重试／不存在／取消），页码恒为 1 且没有翻页入口。
const { state, retry } = useReplyPage(
  (_page, signal) => reader.readConversation({
    dynamicId: props.dynamicId, rootId: props.rootId, replyId: props.replyId, signal,
  }),
  1,
);

const element = ref<HTMLElement | null>(null);
const items = computed<readonly Reply[]>(() => state.value.data?.items ?? []);
const total = computed(() => state.value.data?.count ?? items.value.length);
const incomplete = computed(() => state.value.data?.incomplete === true);
const missing = computed(() => state.value.status === 'not-found');
/** 入口回复就是这段对话的成员：整段读取后它必然在列表里，因此标记天然唯一。 */
const entryId = computed(() => (items.value.some(item => item.id === props.replyId) ? props.replyId : null));
const noticeStatus = computed<ReadStatus>(() => readNoticeStatus(state.value.status));
const entryAnchor = computed(() => `reply:${props.rootId}:${props.replyId}`);

let stopRestoring: () => void = () => undefined;
let stopCentering: () => void = () => undefined;
let settled = false;

/** 首屏结果渲染完成后只落点一次：恢复位置，或把入口回复定位到滚动源中央。 */
watch(() => state.value.status, status => {
  if (settled || status !== 'success') return;
  settled = true;
  if (props.restore) {
    stopRestoring = restoreReadingPosition(element.value, props.restore, undefined, props.scroller);
    return;
  }
  stopCentering = centerReadingAnchor(element.value, entryAnchor.value, props.scroller);
}, { flush: 'post', immediate: true });

onBeforeUnmount(() => {
  stopRestoring();
  stopCentering();
});

function targetNickname(reply: Reply): string | null {
  return replyTargetNickname(reply, props.rootId);
}

function bodyText(reply: Reply): string {
  const text = replyBodyText(reply.text);
  return text.trim() ? text : '暂无评论内容';
}

/** 承载方（整页/弹窗）在内容真的显示过之后才需要保存阅读位置。 */
defineExpose({
  element,
  shown: () => settled && Boolean(state.value.data),
});
</script>

<template>
  <div ref="element" class="conversation-view">
    <section v-if="missing" class="conversation-status" aria-label="会话结果">
      <p role="status">这条对话不存在或未保存，无法打开。</p>
      <el-button type="primary" link class="conversation-action" @click="emit('leave')">{{ leaveLabel }}</el-button>
    </section>
    <ReadNotice
      v-if="!state.data && !missing"
      :status="noticeStatus"
      area="会话"
      @retry="retry"
    />
    <template v-if="state.data">
      <p class="conversation-count" role="status">共 {{ total }} 条</p>
      <p v-if="incomplete" class="conversation-status" role="status">部分上下文暂不可用</p>
      <ul
        v-if="items.length > 0"
        class="conversation-list"
        aria-label="对话内容"
      >
        <li
          v-for="item in items"
          :key="item.id"
          class="conversation-reply"
          :class="{ 'conversation-reply--entry': entryId === item.id }"
          :data-reading-id="`reply:${rootId}:${item.id}`"
          :data-conversation-entry="entryId === item.id ? 'true' : undefined"
          :aria-current="entryId === item.id ? 'true' : undefined"
        >
          <div class="conversation-reply__identity">
            <UserAvatar :user="item.author" :size="24" class="conversation-avatar" />
            <span class="conversation-nickname">{{ item.author.nickname ?? '未知用户' }}</span>
            <span v-if="entryId === item.id" class="conversation-entry-mark">刚才查看</span>
          </div>
          <p class="conversation-reply__text">
            <span v-if="targetNickname(item)" class="conversation-reply__target">回复 {{ targetNickname(item) }}:</span>{{ bodyText(item) }}
          </p>
          <div class="conversation-metrics">
            <time class="conversation-time" :datetime="item.publishedAt ?? undefined">
              {{ displayTime(item.publishedAt) }}
            </time>
            <ReadOnlyLike :count="item.likeCount" />
          </div>
        </li>
      </ul>
      <p v-else class="conversation-status" role="status">暂无对话内容</p>
    </template>
  </div>
</template>

<style scoped>
/* 共用标尺在 theme/reading.css：回复条目、状态行与操作链接。 */
.conversation-count {
  padding: 4px 4px 0;
  margin: 0;
  color: var(--muted);
  font-size: var(--font-meta);
  line-height: var(--line-meta);
  font-variant-numeric: tabular-nums;
}
/* 入口回复的轻微标记：说明刚才从哪条进来，定位只做一次、不抢用户滚动。 */
.conversation-reply--entry {
  background: var(--brand-soft);
  box-shadow: inset 3px 0 0 var(--brand);
}
/* “刚才查看”与徽标同一层级：12/20、品牌色，不抢昵称与正文。 */
.conversation-entry-mark {
  color: var(--brand-strong);
  font-size: var(--font-badge);
  line-height: var(--line-badge);
  white-space: nowrap;
}
</style>

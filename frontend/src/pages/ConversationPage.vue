<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElButton } from 'element-plus';
import type { ReadStatus, Reply } from '../data/contracts';
import { useArchiveNavigation } from '../app/navigation';
import { captureReadingPosition, centerReadingAnchor, restoreReadingPosition } from '../app/readingPosition';
import { useSession } from '../app/session';
import { displayTime } from '../dynamics/display';
import { noticeStatus as readNoticeStatus } from '../dynamics/locate';
import { replyBodyText, replyTargetNickname } from '../dynamics/replyText';
import { useReplyPage } from '../dynamics/useReplyPage';
import ReadNotice from '../dynamics/ReadNotice.vue';
import ReadOnlyLike from '../dynamics/ReadOnlyLike.vue';
import UserAvatar from '../dynamics/UserAvatar.vue';

/**
 * 会话列表：一段对话的独立只读页。身份是动态、根评论与入口回复，不以页码或昵称充当身份；
 * 一次请求读完整个本地可确认集合，按时间正序整段展示，没有分页控件也不循环拼页。
 * 一级评论只作上下文不重复展示；入口回复标“刚才查看”，并在新进入时一次性定位：
 * 能居中就居中，位置夹在真实可滚动范围内，不为居中给列表补留白（短会话/末条不留空白带）。
 * 同一访问的历史恢复优先回到上次的阅读位置，不重复定位、不抢用户滚动。
 */
const props = defineProps<{ dynamicId: string; rootId: string; replyId: string }>();

const { reader } = useSession();
const navigation = useArchiveNavigation();
// 访问身份在 setup 时固定：卸载时仍按本次访问保存位置，不受已经切换的路由影响。
const pageEntryId = navigation.pageEntryId;
// 已有访问（历史前进/后退）只恢复位置；新进入/直达/刷新没有记录，才定位一次。
const restored = navigation.conversationRead ?? null;
// 整段读取复用同一套读取状态机（加载／失败重试／不存在／取消），页码恒为 1 且没有翻页入口。
const { state, retry } = useReplyPage(
  (_page, signal) => reader.readConversation({
    dynamicId: props.dynamicId, rootId: props.rootId, replyId: props.replyId, signal,
  }),
  1,
);

const container = ref<HTMLElement | null>(null);

const items = computed<readonly Reply[]>(() => state.value.data?.items ?? []);
const total = computed(() => state.value.data?.count ?? items.value.length);
const incomplete = computed(() => state.value.data?.incomplete === true);
const missing = computed(() => state.value.status === 'not-found');
/** 入口回复就是这段对话的成员：整段读取后它必然在列表里，因此标记天然唯一。 */
const entryId = computed(() => (items.value.some(item => item.id === props.replyId) ? props.replyId : null));
const noticeStatus = computed<ReadStatus>(() => readNoticeStatus(state.value.status));
const entryAnchor = `reply:${props.rootId}:${props.replyId}`;

let stopRestoring: () => void = () => undefined;
let stopCentering: () => void = () => undefined;
let settled = false;

/** 首屏结果渲染完成后只落点一次：恢复这次访问的位置，或把入口回复定位到视口中央。 */
watch(() => state.value.status, status => {
  if (settled || status !== 'success') return;
  settled = true;
  if (restored) {
    stopRestoring = restoreReadingPosition(container.value, restored.position);
    return;
  }
  stopCentering = centerReadingAnchor(container.value, entryAnchor);
}, { flush: 'post', immediate: true });

// 离开这次访问（返回、前进后退）时保存阅读位置：同一访问再回来优先恢复，不重新居中。
// 只有内容真的显示过的访问才保存：加载中、读取失败或不存在就离开时还没有可恢复的位置，
// 记下来会让这次访问再回来既不居中、又落回无内容时的滚动位置。用户取消自动定位仍照常保存其实际阅读。
onBeforeUnmount(() => {
  stopRestoring();
  stopCentering();
  if (!settled || !state.value.data) return;
  // 居中不再补留白，所以只需记位置：同一访问回来时滚动范围与离开时一致。
  navigation.saveConversationRead(pageEntryId, { position: captureReadingPosition(container.value) });
});

function back(): void {
  navigation.returnFromConversation(props.dynamicId, props.rootId);
}

function targetNickname(reply: Reply): string | null {
  return replyTargetNickname(reply, props.rootId);
}

function bodyText(reply: Reply): string {
  const text = replyBodyText(reply.text);
  return text.trim() ? text : '暂无评论内容';
}
</script>

<template>
  <div ref="container" class="conversation-visit">
    <el-button class="conversation-back" text aria-label="会话列表，返回评论详情" @click="back">‹ 会话列表</el-button>
    <section v-if="missing" class="conversation-status" aria-label="会话结果">
      <p role="status">这条对话不存在或未保存，无法打开。</p>
      <el-button type="primary" link class="conversation-action" @click="back">返回评论详情</el-button>
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
/* 共用标尺在 theme/reading.css：访问容器、返回控件、回复条目、状态行与操作链接。 */
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

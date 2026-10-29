<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { ElButton } from 'element-plus';
import type { Dynamic } from '../data/contracts';
import type { CommentSnapshot } from '../app/snapshots';
import { emptyCommentSnapshot } from '../app/snapshots';
import { useSession } from '../app/session';
import { useArchiveNavigation } from '../app/navigation';
import { useCompactViewport } from '../app/useCompactViewport';
import { useVisitPosition } from '../app/useVisitPosition';
import { useDetailRead } from './useDetailRead';
import CommentSection from './CommentSection.vue';
import DynamicContent from './DynamicContent.vue';
import ReadNotice from './ReadNotice.vue';

const props = defineProps<{
  dynamicId: string;
  commentTargetId?: string | null;
  /** 楼中楼回复精确入口：需要同时带上所属根评论才能读到目标回复。 */
  replyTargetId?: string | null;
}>();
const { reader } = useSession();
const navigation = useArchiveNavigation();
// 窄屏保留 `‹ 动态列表`，宽屏正常详情不再重复页头（标题仍由标签页标题承担）。
const compact = useCompactViewport();
// 访问身份在 setup 时固定：卸载时仍按本次访问保存，不受已经切换的路由影响。
const pageEntryId = navigation.pageEntryId;
const initial = navigation.detailSnapshot;
const content = shallowRef<Dynamic | null>(initial?.dynamic ?? null);
const comments = shallowRef<CommentSnapshot>(initial?.comments ?? emptyCommentSnapshot());
// 只有新访问才消费评论入口意图；历史恢复按快照位置还原，不再抢到评论区。
const target = initial ? 'top' : navigation.detailTarget;
// 精确入口的主动定位同理：只属于新访问；返回/历史恢复按快照位置与已读批次还原。
const locateOnEntry = !initial;
const entryAllowed = ref(true);
const { state, retry } = useDetailRead(reader, props.dynamicId, initial?.dynamic ?? null);
// 与评论/回复不同：动态详情把“不存在”渲染成自己的提示（下方 <p>），
// 通用读取提示这里映射成 null 表示“不渲染”，不是把它当成功。
const noticeStatus = computed(() => state.value.status === 'not-found' ? null : state.value.status);
const root = ref<HTMLElement | null>(null);
// 主动入口没有快照，定位到顶部；历史恢复才按稳定锚点返回原位置。
useVisitPosition(root, initial?.position ?? null, position => {
  navigation.saveDetailSnapshot(pageEntryId, { dynamic: content.value, comments: comments.value, position });
}, () => { entryAllowed.value = false; });

watch(state, value => {
  if (value.status === 'success' && value.data) content.value = value.data;
});

/** 用户主动滚动/触摸/按键后，入口与排序的迟到定位不再抢回。 */
const canLocate = computed(() => entryAllowed.value);

/**
 * 读取失败、已取消与地址无效仍留一个退出入口：删掉的是正常阅读的重复页头，
 * 不是把用户困在没有内容的详情页。加载中属于瞬时状态，不额外加入口。
 */
const recoverable = computed(() =>
  state.value.status === 'error' || state.value.status === 'cancelled' || state.value.status === 'not-found');
const showBack = computed(() => compact.value || recoverable.value);
</script>

<template>
  <div ref="root" class="detail-visit">
    <el-button
      v-if="showBack"
      class="detail-back"
      text
      @click="navigation.returnToList()"
    >‹ 动态列表</el-button>
    <!-- 视觉上不再重复页头；保留给读屏与页面结构的标题层级。 -->
    <h1 class="visually-hidden">动态详情</h1>
    <ReadNotice v-if="noticeStatus" :status="noticeStatus" area="动态详情" @retry="retry" />
    <p v-if="state.status === 'not-found'" class="detail-notice" role="status">动态不存在或不可用</p>
    <article
      v-if="state.status === 'success' && state.data"
      class="detail-card"
      :data-reading-id="`dynamic:${dynamicId}`"
    >
      <DynamicContent :dynamic="state.data" :comment-entry="false" />
    </article>
    <CommentSection
      v-if="state.status === 'success' && state.data"
      :dynamic-id="dynamicId"
      :author-id="state.data.author.id"
      :source-comment-count="state.data.commentCount"
      :archive="state.data.archive"
      :snapshot="comments"
      :target="target"
      :can-locate="canLocate"
      :locate-root-id="commentTargetId ?? null"
      :locate-reply-id="replyTargetId ?? null"
      :locate-on-entry="locateOnEntry"
      @update:snapshot="comments = $event"
    />
  </div>
</template>

<style scoped>
.detail-visit {
  width: 100%;
  max-width: var(--column-max);
  min-width: 0;
  margin: 0 auto;
  padding: 0 0 40px;
}
/* 普通阅读返回链接：14/22、常规字重，点击区仍不小于 44px。 */
.detail-back {
  min-height: var(--touch);
  padding: 0 4px;
  color: var(--action);
  font-size: var(--font-link);
  font-weight: 400;
  line-height: var(--line-link);
}
.detail-notice {
  padding: 12px 0;
  margin: 0;
  color: var(--muted);
  font-size: var(--font-link);
  line-height: var(--line-link);
}
.detail-card {
  min-width: 0;
  padding: var(--card-padding) var(--card-padding) 8px;
  background: var(--card-bg);
  border-radius: var(--radius);
}
</style>

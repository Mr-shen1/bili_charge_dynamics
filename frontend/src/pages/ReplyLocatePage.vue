<script setup lang="ts">
import DetailVisit from '../dynamics/DetailVisit.vue';
import CommentThreadPage from './CommentThreadPage.vue';
import { useArchiveNavigation } from '../app/navigation';
import { useCompactViewport } from '../app/useCompactViewport';

/**
 * 楼中楼回复精确入口：动态、所属根评论与目标回复身份都在路径里。
 * 宽屏在动态详情内定位所属根评论的回复区（不另建一套评论阅读器）；
 * 窄屏走原有的独立楼中楼页，并直接显示目标所在页。
 * 两条分支共用同一链接，直开、刷新与历史返回都不依赖旧会话。
 */
defineProps<{ dynamicId: string; rootId: string; replyId: string }>();

const navigation = useArchiveNavigation();
const compact = useCompactViewport();
</script>

<template>
  <CommentThreadPage
    v-if="compact"
    :key="navigation.pageEntryId"
    :dynamic-id="dynamicId"
    :root-id="rootId"
    :reply-id="replyId"
  />
  <!-- 所属根评论只作定位上下文：先读到含该根的评论批次，再由回复区定位目标。 -->
  <DetailVisit
    v-else
    :key="navigation.pageEntryId"
    :dynamic-id="dynamicId"
    :comment-target-id="rootId"
    :reply-target-id="replyId"
  />
</template>

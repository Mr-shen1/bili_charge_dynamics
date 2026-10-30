<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { ElButton } from 'element-plus';
import { captureReadingPosition } from '../app/readingPosition';
import { useArchiveNavigation } from '../app/navigation';
import ConversationView from '../dynamics/ConversationView.vue';

/**
 * 会话列表页（手机「查看对话」的落点）：整页承载 `ConversationView`。
 * 这一层只负责页面外壳——`‹ 会话列表` 返回、同一访问的阅读位置快照；
 * 读取、入口标记与一次性定位都在视图里，桌面弹窗复用同一份实现。
 */
const props = defineProps<{ dynamicId: string; rootId: string; replyId: string }>();

const navigation = useArchiveNavigation();
// 访问身份在 setup 时固定：卸载时仍按本次访问保存位置，不受已经切换的路由影响。
const pageEntryId = navigation.pageEntryId;
// 已有访问（历史前进/后退）只恢复位置；新进入/直达/刷新没有记录，才定位一次。
const restored = navigation.conversationRead?.position ?? null;
const view = ref<{ element: HTMLElement | null; shown: () => boolean } | null>(null);

onBeforeUnmount(() => {
  const instance = view.value;
  // 只有内容真的显示过的访问才保存：加载中、读取失败或不存在就离开时还没有可恢复的位置。
  if (!instance?.shown()) return;
  navigation.saveConversationRead(pageEntryId, { position: captureReadingPosition(instance.element) });
});

function back(): void {
  navigation.returnFromConversation(props.dynamicId, props.rootId);
}
</script>

<template>
  <div class="conversation-visit">
    <el-button class="conversation-back" text aria-label="会话列表，返回评论详情" @click="back">‹ 会话列表</el-button>
    <ConversationView
      ref="view"
      :dynamic-id="dynamicId"
      :root-id="rootId"
      :reply-id="replyId"
      :restore="restored"
      leave-label="返回评论详情"
      @leave="back"
    />
  </div>
</template>

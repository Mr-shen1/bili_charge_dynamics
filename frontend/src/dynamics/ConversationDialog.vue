<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ElDialog } from 'element-plus';
import { useConversationDialog } from './conversationDialog';
import ConversationView from './ConversationView.vue';

/**
 * 桌面「查看对话」：在内联楼中楼旁边把整段对话读一遍，不离开详情页。
 * 弹窗自己就是滚动源，`ConversationView` 的入口定位与夹紧都在这个容器内完成；
 * 背景页面不卸载，所以展开的评论、排序、页码与滚动位置自然保留。
 */
const dialog = useConversationDialog();
const body = ref<HTMLElement | null>(null);
const open = computed({
  get: () => dialog.state.open,
  set: value => { if (!value) dialog.close(); },
});

// 关闭后弹窗内容先被卸载（焦点会掉到 body），再把握着的触发元素还回去。
watch(open, value => {
  if (value) return;
  void nextTick(() => dialog.restoreFocus());
});
</script>

<template>
  <el-dialog
    v-model="open"
    class="conversation-dialog"
    title="对话"
    width="min(720px, 92vw)"
    align-center
    append-to-body
    destroy-on-close
    @closed="dialog.restoreFocus()"
  >
    <div ref="body" class="conversation-dialog__body">
      <ConversationView
        v-if="open"
        :dynamic-id="dialog.state.dynamicId"
        :root-id="dialog.state.rootId"
        :reply-id="dialog.state.replyId"
        :scroller="body"
        leave-label="关闭"
        @leave="dialog.close()"
      />
    </div>
  </el-dialog>
</template>

<style scoped>
/* 弹窗内容自己滚：整段对话可能有几十条，外层不再撑高页面。 */
.conversation-dialog__body {
  max-height: 70vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}
</style>

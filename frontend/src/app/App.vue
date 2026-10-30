<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { createImagePreviewCoordinator, provideImagePreview } from '../preview/useImagePreview';
import PreviewHost from '../preview/PreviewHost.vue';
import { assembly } from './assembly';
import { useDocumentTitle } from './documentTitle';
import { createArchiveNavigation, provideArchiveNavigation } from './navigation';
import { createConversationDialog, provideConversationDialog } from '../dynamics/conversationDialog';
import ConversationDialog from '../dynamics/ConversationDialog.vue';

// 会话实例在应用根部创建并高于路由页面存活；导航协调器先装配，
// 图片预览只接管组与手势，历史记录与位置恢复仍由导航协调器决定。
const navigation = createArchiveNavigation();
provideArchiveNavigation(navigation);
const coordinator = createImagePreviewCoordinator(navigation);
provideImagePreview(coordinator);
// 桌面「查看对话」弹窗与路由无关：开关随应用存活，关闭即丢弃，不写地址。
provideConversationDialog(createConversationDialog());

// 标签标题按路由身份统一设置：新标签、直达与刷新都得到同一标题，页面不再各自维护。
const route = useRoute();
useDocumentTitle(computed(() => route.name));
</script>

<template>
  <!--
    阅读页不再有公共品牌与主导航：正文直接占用整屏宽度，管理由独立 `/manage` 地址进入，
    管理页自带「返回阅读」导航（`ManageShell`）。去掉入口不是鉴权措施，见正式设计 §3.1。
    自检入口只在 mock/fault 装配的自检页内部提供，生产构建不存在。
  -->
  <div class="app-shell">
    <main class="app-main" data-preview-fallback-focus tabindex="-1">
      <RouterView />
    </main>
  </div>
  <span v-if="assembly.kind !== 'production'" class="app-badge">{{ assembly.kind }}</span>
  <PreviewHost />
  <ConversationDialog />
</template>

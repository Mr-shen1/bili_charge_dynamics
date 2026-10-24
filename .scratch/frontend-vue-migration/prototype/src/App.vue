<script setup lang="ts">
import { imageGroups } from './demo/fixtures';
import { createImagePreviewCoordinator, provideImagePreview } from './preview/useImagePreview';
import PreviewHost from './preview/PreviewHost.vue';

// 会话实例在应用根部创建并高于路由页面存活；图片组由装配层注入，预览宿主只挂载一次，避免双预览。
const coordinator = createImagePreviewCoordinator(imageGroups);
provideImagePreview(coordinator);
</script>

<template>
  <div class="app-shell">
    <nav class="app-nav" aria-label="验证导航">
      <RouterLink to="/">图片验证页</RouterLink>
      <RouterLink to="/other">第二页</RouterLink>
    </nav>
    <main class="app-main" data-preview-fallback-focus tabindex="-1">
      <RouterView />
    </main>
  </div>
  <PreviewHost />
</template>

<script setup lang="ts">
import { createImagePreviewCoordinator, provideImagePreview } from '../preview/useImagePreview';
import PreviewHost from '../preview/PreviewHost.vue';
import { assembly, previewFixturesEnabled } from './assembly';
import { createArchiveNavigation, provideArchiveNavigation } from './navigation';

// 会话实例在应用根部创建并高于路由页面存活；导航协调器先装配，
// 图片预览只接管组与手势，历史记录与位置恢复仍由导航协调器决定。
const navigation = createArchiveNavigation();
provideArchiveNavigation(navigation);
const coordinator = createImagePreviewCoordinator(navigation);
provideImagePreview(coordinator);
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <RouterLink class="app-brand" to="/">充电动态归档</RouterLink>
      <nav class="app-nav" aria-label="主导航">
        <RouterLink to="/">归档</RouterLink>
        <RouterLink to="/manage">监控管理</RouterLink>
        <RouterLink v-if="previewFixturesEnabled" :to="{ name: 'preview-fixtures' }">图片自检</RouterLink>
      </nav>
      <span v-if="assembly.kind !== 'production'" class="app-badge">{{ assembly.kind }}</span>
    </header>
    <main class="app-main" data-preview-fallback-focus tabindex="-1">
      <RouterView />
    </main>
  </div>
  <PreviewHost />
</template>

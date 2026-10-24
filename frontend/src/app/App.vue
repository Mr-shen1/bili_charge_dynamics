<script setup lang="ts">
import { createImagePreviewCoordinator, provideImagePreview } from '../preview/useImagePreview';
import PreviewHost from '../preview/PreviewHost.vue';
import { assembly, previewFixturesEnabled } from './assembly';

// 会话实例在应用根部创建并高于路由页面存活；图片组由装配层注入，预览宿主只挂载一次，避免双预览。
const coordinator = createImagePreviewCoordinator();
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

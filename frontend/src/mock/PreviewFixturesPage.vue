<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import ThumbnailGrid from '../preview/ThumbnailGrid.vue';
import { imageGroups } from './fixtures';
import { useImagePreview } from '../preview/useImagePreview';

const preview = useImagePreview();
const groups = imageGroups;

// 夹具只在 mock/fault 装配的这页注入，生产构建不会加载它们。
onMounted(() => preview.setGroups(groups));
onBeforeUnmount(() => preview.setGroups([]));
</script>

<template>
  <section class="page">
    <h1>图片预览与浏览器历史验证</h1>
    <p class="page__note">
      受控夹具：缩略图与预览使用不同地址；混合组包含坏图、未上传、无效地址与可重试失败。本页不连接真实 API、OSS 或上游采集。
    </p>
    <div class="page__filler" aria-hidden="true">向下滚动后打开图片，验证关闭预览时的位置恢复。</div>
    <section v-for="group in groups" :key="group.id" class="page__group" :data-group="group.id">
      <h2>{{ group.label }}（{{ group.owner === 'dynamic' ? '动态图片' : '评论图片' }}）</h2>
      <ThumbnailGrid :group="group" :display-limit="9" />
    </section>
  </section>
</template>

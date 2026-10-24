<script setup lang="ts">
import { computed, watchEffect } from 'vue';
import type { DynamicImage, ImageOwner } from '../data/contracts';
import { previewGroup } from './groups';
import ThumbnailGrid from './ThumbnailGrid.vue';
import { useImagePreview } from './useImagePreview';

const props = defineProps<{
  owner: ImageOwner;
  images: readonly DynamicImage[];
  /** 列表只展示前若干张，完整组仍注册给预览；不传表示全部展示。 */
  displayLimit?: number;
}>();

const preview = useImagePreview();
const group = computed(() => previewGroup(props.owner, props.images));
const limit = computed(() => props.displayLimit ?? props.images.length);

// 组注册在页面可见内容渲染前完成：预览打开时即可按所点索引解析完整组。
watchEffect(() => {
  if (group.value.images.length) preview.registerGroups([group.value]);
});
</script>

<template>
  <ThumbnailGrid v-if="group.images.length" :group="group" :display-limit="limit" />
</template>

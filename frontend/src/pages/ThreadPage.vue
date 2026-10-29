<script setup lang="ts">
import CommentThreadPage from './CommentThreadPage.vue';
import { useArchiveNavigation } from '../app/navigation';

/**
 * 楼中楼路由的访问外壳：同一条路径的多次访问（前进/后退、另一根或另一动态）
 * 都按访问标识重建页面，回复访问快照与阅读位置不会从另一次访问串过来。
 */
defineProps<{ dynamicId: string; rootId: string }>();

const navigation = useArchiveNavigation();
</script>

<template>
  <CommentThreadPage :key="navigation.pageEntryId" :dynamic-id="dynamicId" :root-id="rootId" />
</template>

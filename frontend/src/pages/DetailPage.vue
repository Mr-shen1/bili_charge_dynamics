<script setup lang="ts">
import DetailVisit from '../dynamics/DetailVisit.vue';
import { useArchiveNavigation } from '../app/navigation';

// rootId 只出现在精确入口；普通详情入口没有它，因此不会产生定位意图。
defineProps<{ dynamicId: string; rootId?: string }>();
const navigation = useArchiveNavigation();
</script>

<template>
  <!-- 同一路径的多次访问按访问标识隔离，参数变化也不会复用上一次的阅读状态。 -->
  <DetailVisit :key="navigation.pageEntryId" :dynamic-id="dynamicId" :comment-target-id="rootId ?? null" />
</template>

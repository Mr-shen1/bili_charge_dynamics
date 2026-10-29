<script setup lang="ts">
import { computed } from 'vue';
import ListVisit from '../dynamics/ListVisit.vue';
import type { ArchiveScope } from '../data/contracts';
import { useArchiveNavigation } from '../app/navigation';

const props = defineProps<{ upId?: string }>();
const navigation = useArchiveNavigation();
const scope = computed<ArchiveScope>(() =>
  props.upId === undefined ? { kind: 'all' } : { kind: 'up', upId: props.upId });
const heading = computed(() => props.upId === undefined ? '全部动态' : `UP ${props.upId} 动态`);
</script>

<template>
  <section class="list-shell">
    <h1 class="visually-hidden">{{ heading }}</h1>
    <!-- 每次历史访问都有独立标识：返回时按该访问的快照还原批次、展开与位置。 -->
    <ListVisit :key="navigation.pageEntryId" :scope="scope" />
  </section>
</template>

<style scoped>
.list-shell {
  width: 100%;
  max-width: var(--column-max);
  min-width: 0;
  margin: 0 auto;
  padding: 0 0 40px;
}
</style>

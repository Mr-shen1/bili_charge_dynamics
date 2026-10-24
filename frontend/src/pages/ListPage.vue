<script setup lang="ts">
import { computed } from 'vue';
import ListVisit from '../dynamics/ListVisit.vue';
import type { ArchiveScope } from '../data/contracts';

const props = defineProps<{ upId?: string }>();
const scope = computed<ArchiveScope>(() =>
  props.upId === undefined ? { kind: 'all' } : { kind: 'up', upId: props.upId });
const heading = computed(() => props.upId === undefined ? '全部动态' : `UP ${props.upId} 归档`);
const visitKey = computed(() => props.upId ?? 'all');
</script>

<template>
  <section class="list-shell">
    <h1 class="visually-hidden">{{ heading }}</h1>
    <ListVisit :key="visitKey" :scope="scope" />
  </section>
</template>

<style scoped>
.list-shell {
  width: 100%;
  max-width: 724px;
  min-width: 0;
  margin: 0 auto;
  padding: 0 0 40px;
}
</style>

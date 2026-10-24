<script setup lang="ts">
import ManageShell from '../manage/ManageShell.vue';
import UpVisit from '../manage/UpVisit.vue';
import { useArchiveNavigation } from '../app/navigation';

defineProps<{ upId: string }>();
const navigation = useArchiveNavigation();
</script>

<template>
  <ManageShell list-link>
    <!-- 访问标识与 UP 一起决定重建：同一地址的新访问不沿用上一访问的反馈与读取态。 -->
    <UpVisit :key="`${navigation.pageEntryId}:${upId}`" :uid="upId" />
  </ManageShell>
</template>

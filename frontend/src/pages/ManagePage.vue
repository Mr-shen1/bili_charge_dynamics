<script setup lang="ts">
import ManageVisit from '../manage/ManageVisit.vue';
import ManageShell from '../manage/ManageShell.vue';
import { useArchiveNavigation } from '../app/navigation';

const navigation = useArchiveNavigation();
</script>

<template>
  <ManageShell>
    <!-- 每次历史访问得到独立的读取与新增反馈，离开页面后迟到回调不再落到新访问。 -->
    <ManageVisit :key="navigation.pageEntryId" />
  </ManageShell>
</template>

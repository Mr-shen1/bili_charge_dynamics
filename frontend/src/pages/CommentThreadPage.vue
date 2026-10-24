<script setup lang="ts">
defineProps<{ dynamicId: string; rootId: string }>();
</script>

<template>
  <section class="page">
    <h1>楼中楼</h1>
    <p class="page__note">
      阶段 3 迁移目标：根评论正文 + 实时页码回复（每页最多 10 条），每次重新挂载从第 1 页/顶部开始，
      返回有来源的详情并恢复其状态。当前为骨架占位，动态 ID：<code>{{ dynamicId }}</code>，根评论 ID：<code>{{ rootId }}</code>。
    </p>
  </section>
</template>

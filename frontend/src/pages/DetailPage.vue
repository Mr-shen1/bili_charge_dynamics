<script setup lang="ts">
defineProps<{ dynamicId: string }>();
</script>

<template>
  <section class="page">
    <h1>动态详情</h1>
    <p class="page__note">
      阶段 3 迁移目标：按代码基线展示作者、正文、图片与一级评论区（每批 20 条 cursor），
      支持主动入口定位与历史恢复。当前为骨架占位，动态 ID：<code>{{ dynamicId }}</code>。
    </p>
  </section>
</template>

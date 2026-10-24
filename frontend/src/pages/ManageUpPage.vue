<script setup lang="ts">
defineProps<{ upId: string }>();
</script>

<template>
  <section class="page">
    <h1>单 UP 管理</h1>
    <p class="page__note">
      阶段 3 迁移目标：Element Plus 表单承载启停、互斥模式与近期 N，指定动态的归属校验、草稿隔离与防重，
      以及检查/同步/窗口真实状态。当前为骨架占位，UP：<code>{{ upId }}</code>。
    </p>
  </section>
</template>

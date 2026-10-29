<script setup lang="ts">
/**
 * 管理两条路由共用的页头与栏宽：层级保持「管理列表 → 单 UP 管理」，
 * 不新增全局汇总页。刷新或直达任一地址都在这里得到同一个返回入口。
 */
import './manage.css';

defineProps<{ listLink?: boolean }>();
</script>

<template>
  <section class="manage-shell">
    <header class="manage-header">
      <h1>UP 监控管理</h1>
      <nav class="manage-crumbs" aria-label="页面导航">
        <RouterLink to="/">返回阅读</RouterLink>
        <RouterLink v-if="listLink" to="/manage">UP 列表</RouterLink>
        <span aria-current="page">监控管理</span>
      </nav>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.manage-shell {
  width: 100%;
  max-width: var(--column-max);
  min-width: 0;
  margin: 0 auto;
  padding: 0 0 40px;
}

.manage-header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 16px;
}

.manage-header h1 {
  margin: 0;
  font-size: 20px;
}

.manage-crumbs {
  display: flex;
  /* 三个入口始终同一行：空间不足时整组换行，不在组内折行。 */
  flex-wrap: nowrap;
  gap: 14px;
  margin-left: auto;
  font-size: 13px;
}

/* 链接与当前页标签共用同一盒模型：文字都垂直居中，当前页不会比链接高。 */
.manage-crumbs > * {
  display: inline-flex;
  align-items: center;
  min-height: var(--touch);
  flex: none;
  white-space: nowrap;
}

.manage-crumbs a {
  color: var(--brand-strong);
}
</style>

<script setup lang="ts">
/**
 * 管理两条路由共用的页头与栏宽：层级保持「管理列表 → 单 UP 管理」，
 * 不新增全局汇总页。刷新或直达任一地址都在这里得到同一个返回入口。
 */
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
  max-width: 724px;
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
  flex-wrap: wrap;
  gap: 12px;
  margin-left: auto;
}

.manage-crumbs a {
  display: inline-flex;
  align-items: center;
  min-height: var(--touch);
  color: var(--brand-strong);
}
</style>

<script setup lang="ts">
/**
 * 自检页导航：只在 mock/fault 装配的自检页里出现。
 * 阅读页与管理页都不再有公共顶栏，因此自检页的来回入口留在这里，
 * 不把调试入口（或原型工具栏）带进生产页面。
 */
</script>

<template>
  <nav class="self-check-nav" aria-label="自检导航">
    <RouterLink to="/">返回阅读</RouterLink>
    <RouterLink :to="{ name: 'preview-fixtures' }">图片自检</RouterLink>
    <RouterLink :to="{ name: 'preview-other' }">自检第二页</RouterLink>
  </nav>
</template>

<style scoped>
.self-check-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin: 0 0 16px;
}

.self-check-nav a {
  display: inline-flex;
  align-items: center;
  min-height: var(--touch);
  color: var(--action);
  font-size: 14px;
  line-height: 22px;
  text-decoration: none;
}

.self-check-nav a.router-link-active {
  font-weight: 600;
}
</style>

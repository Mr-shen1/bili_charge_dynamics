<template>
  <section class="page">
    <h1>预览自检第二页</h1>
    <p class="page__note">用于验证预览后退只关闭预览、不会多退一级；也用于确认前进能恢复对应图片。</p>
    <RouterLink class="page__link" :to="{ name: 'preview-fixtures' }">进入图片验证页</RouterLink>
  </section>
</template>

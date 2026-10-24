<script setup lang="ts">
defineProps<{ upId?: string }>();
</script>

<template>
  <section class="page">
    <h1>{{ upId ? '单 UP 归档' : '全部归档' }}</h1>
    <p class="page__note">
      阶段 3 迁移目标：{{ upId ? `/ups/${upId}` : '/' }} 的 scope 切换、cursor 追加（每批 10 条）、阅读位置恢复
      与卡片/图片/评论入口。当前为骨架占位，数据装配在票据 02 落地。
    </p>
  </section>
</template>

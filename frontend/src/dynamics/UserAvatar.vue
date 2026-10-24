<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { User } from '../data/contracts';

const props = withDefaults(defineProps<{ user: User; size?: number; decorative?: boolean }>(), {
  size: 48,
  decorative: false,
});
const failed = ref(false);
watch(() => props.user.avatarUrl, () => { failed.value = false; });

// 头像地址不可用时退回应用自有占位，不请求来源页面或其他业务图。
const source = computed(() => props.user.avatarUrl && !failed.value ? props.user.avatarUrl : '/default-avatar.svg');
const label = computed(() => props.decorative ? '' : `${props.user.nickname ?? '未知用户'}的头像`);
</script>

<template>
  <img
    class="user-avatar"
    :src="source"
    :alt="label"
    :width="size"
    :height="size"
    referrerpolicy="no-referrer"
    @error="failed = true"
  />
</template>

<style scoped>
.user-avatar {
  border-radius: 50%;
  object-fit: cover;
  background: #f1f2f3;
}
</style>

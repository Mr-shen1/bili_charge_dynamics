<script setup lang="ts">
import { ElButton } from 'element-plus';
import type { ReadStatus } from '../data/contracts';

defineProps<{ status: ReadStatus; area: string }>();
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <p v-if="status === 'loading'" class="read-notice" role="status">{{ area }}加载中…</p>
  <div v-else-if="status === 'error' || status === 'cancelled'" class="read-notice read-notice--action">
    <p v-if="status === 'error'" role="alert">{{ area }}读取失败，请重试。</p>
    <p v-else role="status">读取已取消，可重新读取。</p>
    <el-button type="primary" link class="read-notice__retry" @click="emit('retry')">
      {{ status === 'error' ? '重试' : '重新读取' }}
    </el-button>
  </div>
</template>

<style scoped>
.read-notice {
  padding: 12px 0;
  margin: 0;
  color: var(--muted);
  font-size: var(--font-link);
  line-height: var(--line-link);
  overflow-wrap: anywhere;
}
.read-notice--action {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.read-notice--action p {
  margin: 0;
}
.read-notice__retry {
  min-height: var(--touch);
}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElAlert, ElButton } from 'element-plus';
import { useSession } from '../app/session';
import type { MonitorConfig } from './managementApi';
import UpCard from './UpCard.vue';
import { useManagementRead } from './useManagementRead';
import { useManagementRequests } from './useManagementRequests';

const props = defineProps<{ uid: string }>();
const { management } = useSession();
// 单 UP 页沿用基线：读取身份集合后按 UID 定位，不额外调用 getUp。
const { ups, state: readState, error: readError, reload } = useManagementRead(signal =>
  management.listUps({ signal }));
const { busyUids, run } = useManagementRequests();
const notice = ref<{ error: boolean; text: string } | null>(null);
const up = computed(() => ups.value.find(item => item.uid === props.uid) ?? null);

/** 启停只提交该 UP 已保存的配置；失败保留已保存状态并原位给重试入口。 */
async function toggle(monitor: MonitorConfig): Promise<void> {
  const current = up.value;
  if (!current || busyUids.value.has(current.uid)) return;
  notice.value = null;
  const result = await run(current.uid, signal =>
    management.updateMonitor({ uid: current.uid, monitor, signal }));
  // 离开页面或已切换 UP 后，迟到的成功/失败都不改写当前页面。
  if (!result || props.uid !== current.uid) return;
  if (result.status === 'success') {
    ups.value = ups.value.map(item => item.uid === current.uid ? result.data : item);
    notice.value = { error: false, text: '启停已保存。' };
  } else if (result.status === 'error') {
    notice.value = { error: true, text: result.message };
  }
}
</script>

<template>
  <p v-if="readState === 'loading'" class="manage-notice" role="status">正在读取管理配置…</p>
  <div v-else-if="readState === 'error'" class="manage-notice">
    <el-alert :title="readError" type="error" :closable="false" show-icon />
    <el-button type="primary" class="manage-retry" @click="reload()">重新读取</el-button>
  </div>
  <div v-else-if="!up" class="manage-notice">
    <p role="status">未找到该 UP，可能已被删除。</p>
    <RouterLink class="manage-back" to="/manage">返回 UP 列表</RouterLink>
  </div>
  <UpCard
    v-else
    :up="up"
    :busy="busyUids.has(up.uid)"
    :notice="notice"
    @toggle="toggle"
  />
</template>

<style scoped>
.manage-notice {
  margin: 0;
  padding: 16px;
  color: var(--muted);
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.manage-retry,
.manage-back {
  display: inline-flex;
  align-items: center;
  min-height: var(--touch);
}

.manage-back {
  color: var(--brand-strong);
}
</style>

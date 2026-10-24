<script setup lang="ts">
import { computed } from 'vue';
import { ElAlert, ElButton } from 'element-plus';
import { useSession } from '../app/session';
import type { ManagedUp } from './managementApi';
import CheckStatusPanel from './CheckStatusPanel.vue';
import DiscoveryStatusPanel from './DiscoveryStatusPanel.vue';
import UpCard from './UpCard.vue';
import { useManagementRead } from './useManagementRead';
import { useManagementRequests } from './useManagementRequests';

const props = defineProps<{ uid: string }>();
const { management } = useSession();
// 单 UP 页沿用基线：读取身份集合后按 UID 定位，不额外调用 getUp。
const { ups, state: readState, error: readError, reload } = useManagementRead(signal =>
  management.listUps({ signal }));
// 防重锁按 UID 共享给启停、配置保存、删除与目标增删：同一 UP 同时只有一个写入。
const requests = useManagementRequests();
const up = computed(() => ups.value.find(item => item.uid === props.uid) ?? null);
// 已保存配置的签名：模式、N 或启停一变，上一份检查/发现状态不再对应当前配置，必须重读。
const savedConfig = computed(() => {
  const monitor = up.value?.monitor;
  return monitor ? `${monitor.mode}:${monitor.recentN}:${monitor.enabled}` : 'none';
});

function replaceUp(next: ManagedUp): void {
  ups.value = ups.value.map(item => item.uid === next.uid ? next : item);
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
  <!-- UP 或配置存在性变化时重建卡片：换 UP 不沿用上一份草稿、目标输入与反馈。 -->
  <div v-else class="manage-status">
    <UpCard
      :key="`${up.uid}:${up.monitor !== null}`"
      :up="up"
      :requests="requests"
      @change="replaceUp"
    />
    <!-- 状态面板只读取已保存记录；随已保存配置重建，旧状态不会跟着草稿留在页面上。 -->
    <CheckStatusPanel
      :key="`${up.uid}:${savedConfig}`"
      :uid="up.uid"
      :monitor="up.monitor"
    />
    <DiscoveryStatusPanel :key="`${up.uid}:${savedConfig}`" :uid="up.uid" />
  </div>
</template>

<style scoped>
.manage-notice {
  margin: 0;
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

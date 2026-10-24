<script setup lang="ts">
import { computed } from 'vue';
import { ElAlert, ElButton } from 'element-plus';
import UserAvatar from '../dynamics/UserAvatar.vue';
import type { ManagedUp, MonitorConfig } from './managementApi';
import { manageStatus, manageUser } from './status';

/**
 * 单 UP 身份卡：09 只交付启停；模式、目标、检查与发现状态分别由后续票据接入。
 * 启停始终提交该 UP 已保存的配置，不把任何未保存输入当成配置。
 */
const props = defineProps<{ up: ManagedUp; busy: boolean; notice: { error: boolean; text: string } | null }>();
const emit = defineEmits<{ toggle: [monitor: MonitorConfig] }>();

const user = computed(() => manageUser(props.up));
const status = computed(() => manageStatus(props.up));
const monitorText = computed(() => {
  if (!props.up.monitor) return '无配置';
  return props.up.monitor.enabled ? '已启用' : '已停止';
});
const toggleLabel = computed(() => {
  const monitor = props.up.monitor;
  if (!monitor) return '';
  const verb = monitor.enabled ? '停止' : '启用';
  if (props.busy) return `正在${verb}…`;
  if (props.notice?.error) return `重试${verb}`;
  return `${verb}监控`;
});

function toggle(): void {
  const monitor = props.up.monitor;
  if (!monitor || props.busy) return;
  emit('toggle', { mode: monitor.mode, recentN: monitor.recentN, enabled: !monitor.enabled });
}
</script>

<template>
  <article class="manage-up" :aria-label="`UP ${up.uid}`" :aria-busy="busy">
    <header class="manage-identity">
      <UserAvatar :user="user" :size="56" />
      <div class="manage-identity-text">
        <h2 class="manage-author">{{ user.nickname ?? '未知用户' }}</h2>
        <p class="manage-muted">UID：{{ up.uid }}</p>
      </div>
      <span class="manage-badge">{{ status }}</span>
    </header>
    <div class="manage-control-row">
      <p class="manage-state">监控：{{ monitorText }}</p>
      <el-button v-if="up.monitor" class="manage-toggle" :disabled="busy" @click="toggle()">
        {{ toggleLabel }}
      </el-button>
    </div>
    <p v-if="!up.monitor" class="manage-muted">监控配置已删除；身份和已有归档保留。</p>
    <el-alert
      v-if="notice"
      class="manage-feedback"
      :title="notice.text"
      :type="notice.error ? 'error' : 'success'"
      :closable="false"
      show-icon
    />
  </article>
</template>

<style scoped>
.manage-up {
  padding: 16px;
  background: var(--card-bg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}

.manage-identity {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.manage-identity-text {
  flex: 1;
  min-width: 0;
}

.manage-author {
  margin: 0;
  font-size: 16px;
  color: var(--author);
  overflow-wrap: anywhere;
}

.manage-muted {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.manage-badge {
  flex: none;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--el-color-primary-light-9);
  color: var(--brand-strong);
  font-size: 12px;
  white-space: nowrap;
}

.manage-control-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}

.manage-state {
  margin: 0;
}

.manage-toggle {
  min-height: var(--touch);
}

.manage-feedback {
  margin-top: 12px;
}

@media (max-width: 640px) {
  .manage-toggle {
    width: 100%;
  }
}
</style>

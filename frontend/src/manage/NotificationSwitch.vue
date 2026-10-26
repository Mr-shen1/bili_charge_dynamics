<script setup lang="ts">
/**
 * 管理页顶部的飞书通知状态选择：只控制“发哪一类消息”，不控制通知进程启停。
 *
 * 三态：`all` 业务＋系统消息；`system_only` 只发心跳与告警；`off` 一条都不发。
 * 初始状态必须来自 `GET`，切换以后端返回的新状态为准——失败保留原状态，
 * 刷新后读到的就是真实状态（不读本地记忆）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElAlert, ElButton } from 'element-plus';
import { useSession } from '../app/session';
import { reportReadError } from '../app/readError';
import type { NotificationMode, NotificationState } from './managementApi';
import { NOTIFICATION_MODES } from './managementApi';
import { useManagementRequests } from './useManagementRequests';

// 写入沿用页面既有的按目标防重锁：切换在途时不会重复提交，离开页面后迟到结果不落地。
const WRITE_KEY = 'notifications';

const MODE_LABELS: Record<NotificationMode, string> = {
  all: '全部通知',
  system_only: '仅心跳与告警',
  off: '全部关闭',
};

const MODE_HINTS: Record<NotificationMode, string> = {
  all: '动态变化与新评论照常发到各群，心跳与告警同时发送。',
  system_only: '只发心跳与运维告警；动态与评论不登记、不发送。',
  off: '一条飞书消息都不发，包括心跳与告警；飞书通知进程照常运行。',
};

const { management } = useSession();
const state = ref<NotificationState | null>(null);
const readState = ref<'loading' | 'error' | 'ready'>('loading');
const readError = ref('');
const notice = ref<{ error: boolean; text: string } | null>(null);
const { busyUids, run } = useManagementRequests();
const busy = computed(() => busyUids.value.has(WRITE_KEY));
let controller: AbortController | null = null;
let active = false;

async function reload(): Promise<void> {
  if (!active || controller) return;
  const request = new AbortController();
  controller = request;
  readState.value = 'loading';
  try {
    const result = await management.readNotification({ signal: request.signal });
    if (!active || request.signal.aborted || controller !== request) return;
    controller = null;
    if (result.status === 'success') {
      state.value = result.data;
      readState.value = 'ready';
    } else if (result.status === 'error') {
      readError.value = result.message;
      readState.value = 'error';
    }
  } catch (cause) {
    if (!active || request.signal.aborted || controller !== request) return;
    controller = null;
    reportReadError('飞书通知状态', cause);
    readError.value = '管理接口响应异常，请重试。';
    readState.value = 'error';
  }
}

const options = NOTIFICATION_MODES.map(value => ({ value, label: MODE_LABELS[value] }));
const selected = computed<NotificationMode>(() => state.value?.state ?? 'off');
const selectedLabel = computed(() => MODE_LABELS[selected.value]);
const hint = computed(() => MODE_HINTS[selected.value]);

async function change(next: NotificationMode): Promise<void> {
  if (!active || !state.value || next === state.value.state) return;
  notice.value = null;
  const result = await run(WRITE_KEY, signal => management.updateNotification({ state: next, signal }));
  // 被取消或属于已离开的访问：不改写当前页面。
  if (!result) return;
  if (result.status === 'success') {
    state.value = result.data;
    readState.value = 'ready';
    notice.value = {
      error: false,
      text: `飞书通知已切换为「${MODE_LABELS[result.data.state]}」，待发 ${result.data.pending} 条。`,
    };
  } else if (result.status === 'error') {
    notice.value = { error: true, text: result.message };
  }
}

onMounted(() => {
  active = true;
  void reload();
});

onUnmounted(() => {
  active = false;
  controller?.abort();
  controller = null;
});
</script>

<template>
  <section class="notify-switch" aria-label="飞书通知">
    <div class="notify-switch-row">
      <span class="notify-switch-title">飞书通知</span>
      <select
        class="notify-switch-toggle"
        :value="selected"
        :disabled="readState !== 'ready' || busy"
        aria-label="飞书通知状态"
        @change="change(($event.target as HTMLSelectElement).value as NotificationMode)"
      >
        <option v-for="option in options" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
    </div>
    <p v-if="readState === 'loading'" class="manage-state" role="status">正在读取通知状态…</p>
    <el-alert
      v-else-if="readState === 'error'"
      class="manage-feedback"
      :title="readError"
      type="error"
      :closable="false"
      show-icon
    />
    <p v-else class="manage-state" role="status">
      飞书通知：{{ selectedLabel }}，待发 {{ state?.pending ?? 0 }} 条。
    </p>
    <el-alert
      v-if="notice"
      class="manage-feedback"
      :title="notice.text"
      :type="notice.error ? 'error' : 'success'"
      :closable="false"
      show-icon
    />
    <el-button
      v-if="readState === 'error'"
      class="manage-read notify-switch-retry"
      @click="reload()"
    >
      重新读取通知状态
    </el-button>
    <p class="manage-muted">{{ hint }}</p>
    <p class="manage-muted">
      切回「全部通知」只通知切换之后的新变化：关闭或仅系统期间发生的变化不会补发。
    </p>
  </section>
</template>

<style scoped>
.notify-switch {
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line);
}

.notify-switch-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  min-height: var(--touch);
}

.notify-switch-title {
  font-size: 14px;
  font-weight: 600;
}

.notify-switch-retry,
.notify-switch-toggle {
  min-height: var(--touch);
}

.notify-switch-toggle {
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: #fff;
  color: inherit;
  font: inherit;
}

@media (max-width: 640px) {
  .notify-switch-retry {
    width: 100%;
  }
}
</style>

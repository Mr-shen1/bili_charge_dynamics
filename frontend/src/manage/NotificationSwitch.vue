<script setup lang="ts">
/**
 * 管理页顶部的飞书通知总开关：只控制“通知进程是否发送”，不控制进程启停。
 * 初始状态必须来自 `GET`，切换以后端返回的新状态为准——失败保留原状态，
 * 刷新后读到的就是真实状态（不读本地记忆）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElAlert, ElButton } from 'element-plus';
import { useSession } from '../app/session';
import { reportReadError } from '../app/readError';
import type { NotificationState } from './managementApi';
import { useManagementRequests } from './useManagementRequests';

// 写入沿用页面既有的按目标防重锁：切换在途时不会重复提交，离开页面后迟到结果不落地。
const WRITE_KEY = 'notifications';

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
    reportReadError('飞书通知开关', cause);
    readError.value = '管理接口响应异常，请重试。';
    readState.value = 'error';
  }
}

// 与 UP 卡片的启停一致：用带文字与 `aria-pressed` 的按钮，而不是零尺寸输入框式的开关，
// 文字直接说明这次点击会做什么，窄屏与触控下也只有一个可点目标。
const label = computed(() => {
  if (busy.value) return '正在提交…';
  return state.value?.enabled ? '关闭飞书通知' : '开启飞书通知';
});

async function toggle(): Promise<void> {
  if (!active || !state.value) return;
  // 显示状态由 `state` 单向决定：切换失败时保留服务端的真实状态，不本地翻转。
  const enabled = !state.value.enabled;
  notice.value = null;
  const result = await run(WRITE_KEY, signal => management.updateNotification({ enabled, signal }));
  // 被取消或属于已离开的访问：不改写当前页面。
  if (!result) return;
  if (result.status === 'success') {
    state.value = result.data;
    readState.value = 'ready';
    notice.value = {
      error: false,
      text: result.data.enabled
        ? `飞书通知已开启，待发 ${result.data.pending} 条。`
        : '飞书通知已关闭，不再发送。',
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
      <el-button
        class="notify-switch-toggle"
        :loading="busy"
        :disabled="readState !== 'ready'"
        :aria-pressed="state?.enabled === true"
        @click="toggle()"
      >
        {{ label }}
      </el-button>
    </div>
    <p v-if="readState === 'loading'" class="manage-state" role="status">正在读取通知开关…</p>
    <el-alert
      v-else-if="readState === 'error'"
      class="manage-feedback"
      :title="readError"
      type="error"
      :closable="false"
      show-icon
    />
    <p v-else class="manage-state" role="status">
      飞书通知：{{ state?.enabled ? '运行中' : '已关闭' }}，待发 {{ state?.pending ?? 0 }} 条。
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
      重新读取通知开关
    </el-button>
    <p class="manage-muted">关闭后通知进程仍在运行，只是不发送；重新打开会按限速补发积压。</p>
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

@media (max-width: 640px) {
  .notify-switch-retry {
    width: 100%;
  }
}
</style>

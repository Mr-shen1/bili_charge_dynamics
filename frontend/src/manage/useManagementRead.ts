import { onMounted, onUnmounted, ref, type Ref } from 'vue';
import type { ManagedUp, ManagementResult } from './managementApi';
import { reportReadError } from '../app/readError';

/**
 * 管理身份读取：一次读取全量身份（含已删除配置的身份），由页面按 UID 选取。
 * 读取不并发，失败原位重试；组件卸载后迟到的成功/失败都不写入状态。
 */
export function useManagementRead(
  load: (signal: AbortSignal) => Promise<ManagementResult<readonly ManagedUp[]>>,
) {
  const ups: Ref<readonly ManagedUp[]> = ref([]);
  const state = ref<'loading' | 'error' | 'ready'>('loading');
  const error = ref('');
  let request: AbortController | null = null;
  let active = false;

  async function reload(): Promise<void> {
    if (!active || request) return;
    const controller = new AbortController();
    request = controller;
    state.value = 'loading';
    try {
      const result = await load(controller.signal);
      // 取消可能被传输层忽略：仍以本次访问与请求身份为准。
      if (!active || controller.signal.aborted || request !== controller) return;
      request = null;
      if (result.status === 'success') {
        ups.value = result.data;
        state.value = 'ready';
      } else if (result.status === 'error') {
        error.value = result.message;
        state.value = 'error';
      }
    } catch (cause) {
      if (!active || controller.signal.aborted || request !== controller) return;
      request = null;
      reportReadError('管理配置', cause);
      error.value = '管理接口响应异常，请重试。';
      state.value = 'error';
    }
  }

  onMounted(() => {
    active = true;
    void reload();
  });
  onUnmounted(() => {
    active = false;
    request?.abort();
    request = null;
  });

  return { ups, state, error, reload };
}

import { computed, onMounted, onUnmounted, ref, type Ref } from 'vue';
import { reportReadError } from '../app/readError';
import type { ManagementResult } from './managementApi';

/**
 * 管理状态的一次性读取：打开页面不自动读取，也不轮询；失败原位重试。
 * 取消、离开页面或迟到回调都不写入状态，因此旧数据不会冒充当前最新状态。
 */
export function useStatusRead<T>(noun: string, load: (signal: AbortSignal) => Promise<ManagementResult<T>>) {
  const data = ref(null) as Ref<T | null>;
  const state = ref<'idle' | 'loading' | 'error' | 'ready'>('idle');
  const error = ref('');
  let request: AbortController | null = null;
  let active = false;
  const lifetime = new AbortController();

  async function read(): Promise<void> {
    if (!active || request) return;
    const controller = new AbortController();
    request = controller;
    state.value = 'loading';
    try {
      // 卸载时生命周期信号先行取消，传输忽略取消也不会把结果写回已离开的面板。
      const result = await load(AbortSignal.any([controller.signal, lifetime.signal]));
      if (!active || controller.signal.aborted || request !== controller) return;
      request = null;
      if (result.status === 'success') {
        data.value = result.data;
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

  // 按钮文字同时表达在途与重试，读取中不禁用按钮以保住键盘焦点。
  const readLabel = computed(() => {
    if (state.value === 'loading') return `正在读取${noun}…`;
    if (state.value === 'error') return `重试读取${noun}`;
    return data.value === null ? `读取${noun}` : `重新读取${noun}`;
  });

  onMounted(() => {
    active = true;
  });
  onUnmounted(() => {
    active = false;
    lifetime.abort();
    request?.abort();
    request = null;
  });

  return { data, state, error, readLabel, read };
}

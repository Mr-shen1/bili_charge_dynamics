import type { DynamicReader } from '../data/contracts';

/**
 * 开发故障装配：列表与 UP 身份首次读取失败一次，重试恢复；延迟留出离开页面的窗口。
 * 只由 fault mode 引用，普通构建不包含该故障计划。
 */
export function createFaultReader(base: DynamicReader): DynamicReader {
  let listFailures = 1;
  let upsFailures = 1;
  const wait = (signal: AbortSignal): Promise<void> => new Promise(resolve => {
    const timer = setTimeout(resolve, 200);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  return {
    ...base,
    async readUps(input) {
      await wait(input.signal);
      if (input.signal.aborted) return { status: 'cancelled' };
      if (upsFailures > 0) {
        upsFailures -= 1;
        return { status: 'error' };
      }
      return base.readUps(input);
    },
    async readList(input) {
      await wait(input.signal);
      if (input.signal.aborted) return { status: 'cancelled' };
      if (listFailures > 0) {
        listFailures -= 1;
        return { status: 'error' };
      }
      return base.readList(input);
    },
  };
}

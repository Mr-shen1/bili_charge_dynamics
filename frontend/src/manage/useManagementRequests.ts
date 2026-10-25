import { onUnmounted, shallowRef, type ShallowRef } from 'vue';
import type { ManagementResult } from './managementApi';

/**
 * 管理写入的防重锁按 UID 共享给新增表单与身份卡：同一 UID 同时只有一个请求。
 * 除了取消，还校验请求身份与访问是否仍存活，因此传输层忽略取消时，
 * 迟到的成功/失败/完成回调都不会改写当前页面或清掉新的加载态。
 */
export function useManagementRequests() {
  const controllers = new Map<string, AbortController>();
  const busyUids: ShallowRef<ReadonlySet<string>> = shallowRef(new Set<string>());
  let active = true;

  function sync(): void {
    busyUids.value = new Set(controllers.keys());
  }

  async function run<T>(
    uid: string,
    operation: (signal: AbortSignal) => Promise<ManagementResult<T>>,
  ): Promise<ManagementResult<T> | null> {
    if (!active || controllers.has(uid)) return null;
    const controller = new AbortController();
    controllers.set(uid, controller);
    sync();
    try {
      const result = await operation(controller.signal);
      if (!active || controller.signal.aborted || controllers.get(uid) !== controller) return null;
      return result.status === 'cancelled' ? null : result;
    } catch {
      // 取消不是错误；其余异常（含同步抛出）必须变成可见失败，并由 finally 释放写锁，
      // 否则这个 UID 会永久停在在途状态，同一 UP 的后续写入全部被挡掉（票据 15 的 F-15-01）。
      if (!active || controller.signal.aborted || controllers.get(uid) !== controller) return null;
      return { status: 'error', message: '管理接口响应异常，请重试。' };
    } finally {
      if (controllers.get(uid) === controller) {
        controllers.delete(uid);
        sync();
      }
    }
  }

  onUnmounted(() => {
    active = false;
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  });

  return { busyUids, run };
}

export type ManagementRequests = ReturnType<typeof useManagementRequests>;

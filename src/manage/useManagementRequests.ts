import { useEffect, useRef, useState } from 'react';
import type { ManagementApi, ManagementResult } from './managementApi';

// 锁按 UID 共享给新增表单与身份卡；取消之外还校验请求身份，拒绝忽略取消的迟到响应。
export function useManagementRequests(api: ManagementApi) {
  const requests = useRef(new Map<string, AbortController>());
  const [busyUids, setBusyUids] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setBusyUids(new Set());
    return () => {
      for (const request of requests.current.values()) request.abort();
      requests.current.clear();
    };
  }, [api]);
  async function run<T>(uid: string, operation: (signal: AbortSignal) => Promise<ManagementResult<T>>): Promise<ManagementResult<T> | null> {
    if (requests.current.has(uid)) return null;
    const request = new AbortController();
    requests.current.set(uid, request);
    setBusyUids(new Set(requests.current.keys()));
    const result = await operation(request.signal);
    if (request.signal.aborted || requests.current.get(uid) !== request) return null;
    requests.current.delete(uid);
    setBusyUids(new Set(requests.current.keys()));
    return result.status === 'cancelled' ? null : result;
  }
  return { busyUids, run };
}
export type ManagementRequests = ReturnType<typeof useManagementRequests>;

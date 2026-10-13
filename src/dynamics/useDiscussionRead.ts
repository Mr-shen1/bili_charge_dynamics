import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadResult } from '../data/contracts';
import type { DiscussionReadState } from '../app/DetailSnapshot';

interface DiscussionBatch<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

// 每个排序视图/回复根节点独立拥有请求；所属视图卸载使迟到结果及完成失效。
export function useDiscussionRead<Batch extends DiscussionBatch<{ readonly id: string }>>(
  read: (cursor: string | null | undefined, signal: AbortSignal, initial: boolean) => Promise<ReadResult<Batch>>,
  initial?: DiscussionReadState<Batch>,
) {
  const [state, setState] = useState<DiscussionReadState<Batch>>(initial ?? { status: 'loading', data: null });
  const current = useRef(state);
  const request = useRef<AbortController | null>(null);
  const active = useRef(false);
  const update = useCallback((next: DiscussionReadState<Batch>) => {
    current.current = next;
    setState(next);
  }, []);
  const load = useCallback(async () => {
    if (!active.current || request.current) return;
    const previous = current.current.data;
    if (previous?.nextCursor === null) return;
    const controller = new AbortController();
    request.current = controller;
    const valid = () => active.current && request.current === controller && !controller.signal.aborted;
    update({ data: previous, status: 'loading' });
    try {
      const result = await read(previous?.nextCursor, controller.signal, previous === null);
      if (!valid()) return;
      if (result.status === 'success') {
        const seen = new Set(previous?.items.map(item => item.id));
        const additions = result.data.items.filter(item => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
        update({ status: 'success', data: {
          ...previous, ...result.data, items: [...(previous?.items ?? []), ...additions],
        } });
      } else update({ data: previous, status: result.status,
        ...(result.status === 'error' ? { reason: result.reason } : {}) });
    } catch {
      if (valid()) update({ data: previous, status: 'error' });
    } finally {
      if (valid()) request.current = null;
    }
  }, [read, update]);
  useEffect(() => {
    active.current = true;
    if (!initial || initial.status === 'loading' || initial.status === 'cancelled') void load();
    return () => {
      active.current = false;
      request.current?.abort();
      request.current = null;
    };
  }, [load]);
  // 单根重启保留组件身份，只废弃该根请求；根评论排序重挂载还须重置整个回复子树。
  const restart = useCallback(() => {
    if (!active.current) return;
    request.current?.abort();
    request.current = null;
    update({ status: 'loading', data: null });
    void load();
  }, [load, update]);
  return { state, load, restart };
}

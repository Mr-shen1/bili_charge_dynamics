import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadResult } from '../data/contracts';

interface DiscussionBatch<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
interface DiscussionReadState<T> {
  readonly status: ReadResult<DiscussionBatch<T>>['status'] | 'loading';
  readonly data: DiscussionBatch<T> | null;
}

// 每个排序视图/回复根节点独立拥有请求；所属视图卸载使迟到结果及完成失效。
export function useDiscussionRead<T extends { readonly id: string }>(
  read: (cursor: string | null | undefined, signal: AbortSignal, initial: boolean) => Promise<ReadResult<DiscussionBatch<T>>>,
) {
  const [state, setState] = useState<DiscussionReadState<T>>({ status: 'loading', data: null });
  const current = useRef(state);
  const request = useRef<AbortController | null>(null);
  const active = useRef(false);
  const update = useCallback((next: DiscussionReadState<T>) => {
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
          items: [...(previous?.items ?? []), ...additions], nextCursor: result.data.nextCursor,
        } });
      } else update({ data: previous, status: result.status });
    } catch {
      if (valid()) update({ data: previous, status: 'error' });
    } finally {
      if (valid()) request.current = null;
    }
  }, [read, update]);
  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      request.current?.abort();
      request.current = null;
    };
  }, [load]);
  return { state, load };
}

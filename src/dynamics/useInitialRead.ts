import { useEffect, useRef, useState } from 'react';

type InitialState<R> = R | { status: 'loading' } | { status: 'error' };

// 仅协调本票两个首次读取区域；不包含分页、缓存或阅读恢复。
export function useInitialRead<R extends { readonly status: string }>(
  resourceKey: string, load: (signal: AbortSignal) => Promise<R>,
) {
  const [stored, setStored] = useState<{ key: string; load: typeof load; result: InitialState<R> }>({
    key: resourceKey, load, result: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(true);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    pending.current = true;
    setStored({ key: resourceKey, load, result: { status: 'loading' } });
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      const result = await load(controller.signal);
      if (!active) return;
      pending.current = false;
      setStored({ key: resourceKey, load, result });
    }).catch(() => {
      if (!active) return;
      pending.current = false;
      setStored({ key: resourceKey, load, result: { status: 'error' } });
    });
    return () => { active = false; controller.abort(); };
  }, [resourceKey, load, attempt]);

  return {
    // 资源/装配切换的首次渲染也不能短暂显示上一次内容。
    state: stored.key === resourceKey && stored.load === load ? stored.result : { status: 'loading' as const },
    retry() {
      if (pending.current) return;
      pending.current = true;
      setStored({ key: resourceKey, load, result: { status: 'loading' } });
      setAttempt(value => value + 1);
    },
  };
}

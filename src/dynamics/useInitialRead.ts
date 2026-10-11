import { useEffect, useRef, useState } from 'react';

type InitialState<R> = R | { status: 'loading' } | { status: 'error' };

// 协调首次读取；已有成功内容可由所属访问提供，未完成请求不进入快照。
export function useInitialRead<R extends { readonly status: string }>(
  resourceKey: string, load: (signal: AbortSignal) => Promise<R>, initial?: R,
) {
  const [stored, setStored] = useState<{ key: string; load: typeof load; result: InitialState<R> }>({
    key: resourceKey, load, result: initial ?? { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(!initial);
  useEffect(() => {
    if (initial && attempt === 0) return;
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
  }, [resourceKey, load, attempt, initial]);

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

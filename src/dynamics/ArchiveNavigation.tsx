import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ArchiveScope, DynamicReader, ReadResult, User } from '../data/contracts';

/** 最小范围导航仅读持久身份；完整选择条交互留给后续票。 */
export function ArchiveNavigation({ reader, scope }: { reader: DynamicReader; scope: ArchiveScope }) {
  const [result, setResult] = useState<ReadResult<readonly User[]> | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResult(null);
    void reader.readUps({ signal: controller.signal }).then(value => {
      if (active && !controller.signal.aborted) setResult(value);
    }).catch(() => {
      if (active && !controller.signal.aborted) setResult({ status: 'error' });
    });
    return () => { active = false; controller.abort(); };
  }, [reader, attempt]);
  return <nav aria-label="归档范围">
    <Link to="/" aria-current={scope.kind === 'all' ? 'page' : undefined}>全部归档</Link>
    {result?.status === 'success' && result.data.map(user => <span key={user.id}> · <Link to={`/ups/${encodeURIComponent(user.id)}`}
      aria-current={scope.kind === 'up' && scope.upId === user.id ? 'page' : undefined}>{user.nickname ?? `UP ${user.id}`}</Link></span>)}
    {result && result.status !== 'success' && <span role="status"> UP 身份列表读取失败。
      <button type="button" onClick={() => setAttempt(value => value + 1)}>重读 UP 列表</button>
    </span>}
  </nav>;
}

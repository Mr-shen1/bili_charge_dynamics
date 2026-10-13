import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ArchiveScope, DynamicReader, ReadResult, User } from '../data/contracts';
import styles from './ArchiveNavigation.module.css';

function UpOption({ user, selected }: { user: User; selected: boolean }) {
  const nickname = user.nickname ?? '未知用户';
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const avatar = user.avatarUrl && user.avatarUrl !== failedUrl ? user.avatarUrl : '/default-avatar.svg';
  return <Link className={styles.option} to={`/ups/${encodeURIComponent(user.id)}`}
    aria-current={selected ? 'page' : undefined} title={nickname}>
    <img className={styles.avatar} src={avatar} alt="" width="44" height="44" onError={() => setFailedUrl(avatar)} />
    <span className={styles.nickname}>{nickname}</span>
  </Link>;
}

/** 读取保存的身份，不按当前监控配置过滤旧归档入口。 */
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
  return <nav className={styles.navigation} aria-label="归档范围">
    <ul className={styles.options}>
      <li><Link className={styles.option} to="/" aria-current={scope.kind === 'all' ? 'page' : undefined}>
        <span className={styles.allAvatar} aria-hidden="true">全部</span>
        <span className={styles.nickname}>全部归档</span>
      </Link></li>
      {result?.status === 'success' && result.data.map(user => <li key={user.id}>
        <UpOption user={user} selected={scope.kind === 'up' && scope.upId === user.id} />
      </li>)}
    </ul>
    {!result && <p className={styles.notice} role="status">UP 身份列表加载中…</p>}
    {result && result.status !== 'success' && <div className={styles.notice} role="status">
      {result.status === 'cancelled' ? 'UP 身份列表读取已取消。' : 'UP 身份列表读取失败。'}
      <button className={styles.retry} type="button" onClick={() => setAttempt(value => value + 1)}>重读 UP 列表</button>
    </div>}
  </nav>;
}

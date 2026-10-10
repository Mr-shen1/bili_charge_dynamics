import { useState } from 'react';
import type { Dynamic, User } from '../data/contracts';
import styles from './Dynamics.module.css';
import { ListText } from './ListText';

export function Identity({ user, heading = false }: { user: User; heading?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const source = user.avatarUrl && user.avatarUrl !== failedUrl ? user.avatarUrl : '/default-avatar.svg';
  return <div className={styles.identity}>
    <img className={styles.avatar} src={source} alt={`${user.nickname ?? '未知用户'}的头像`}
      width="44" height="44" onError={() => setFailedUrl(source)} />
    {heading ? <h1 className={styles.nickname}>{user.nickname ?? '未知用户'}</h1>
      : <span className={styles.nickname}>{user.nickname ?? '未知用户'}</span>}
  </div>;
}

function displayTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未知';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

export function DynamicContent({ dynamic, folding }: {
  dynamic: Dynamic; folding?: { expanded: boolean; toggle(): void };
}) {
  const text = dynamic.text.trim() ? dynamic.text : '暂无内容';
  return <>
    <Identity user={dynamic.author} />
    <time className={styles.time} dateTime={dynamic.publishedAt ?? undefined}>{displayTime(dynamic.publishedAt)}</time>
    {folding ? <ListText text={text} expanded={folding.expanded} toggle={folding.toggle} />
      : <p className={styles.text}>{text}</p>}
    <p className={styles.count}>评论 {dynamic.commentCount ?? '—'}</p>
  </>;
}

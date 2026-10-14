import type { ReactNode } from 'react';
import type { Dynamic, User } from '../data/contracts';
import styles from './Dynamics.module.css';
import { FoldableText } from './FoldableText';
import { ImageGrid } from '../images/ImageGrid';
import { UserAvatar } from './UserAvatar';

export function Identity({ user, children, inline = false }: { user: User; children?: ReactNode; inline?: boolean }) {
  const Container = inline ? 'span' : 'div';
  return <Container className={styles.identity} data-display-identity>
    <UserAvatar user={user} className={styles.avatar} />
    <Container className={styles.identityDetails}><span className={styles.nickname}>{user.nickname ?? '未知用户'}</span>{children}</Container>
  </Container>;
}

export function displayTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未知';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

export function DynamicContent({ dynamic, folding, navigateToComments }: {
  dynamic: Dynamic; folding?: { expanded: boolean; toggle(): void }; navigateToComments?(): void;
}) {
  const archive = dynamic.archive;
  const hasMedia = Boolean(dynamic.images?.length || archive?.mediaSources.length);
  const emptyContent = !hasMedia && (!archive || archive.contentState === 'success') ? '暂无内容' : '';
  const text = dynamic.text.trim() ? dynamic.text : emptyContent;
  const commentLabel = `${archive ? '来源评论' : '评论'} ${dynamic.commentCount ?? '—'}`;
  return <>
    <header className={styles.dynamicHeader}>
      <Identity user={dynamic.author}>
        <time className={styles.time} dateTime={dynamic.publishedAt ?? undefined}>{displayTime(dynamic.publishedAt)}</time>
      </Identity>
    </header>
    <div className={styles.dynamicBody}>
    {archive?.title && <h2 className={styles.text}>{archive.title}</h2>}
    {text && (folding ? <FoldableText text={text} expanded={folding.expanded} toggle={folding.toggle} />
      : <p className={styles.text}>{text}</p>)}
    {!!dynamic.images?.length && <ImageGrid owner={{ type: 'dynamic', id: dynamic.id }} images={dynamic.images} list={!!folding} />}
    {navigateToComments && <button className={styles.commentEntry} type="button" onClick={navigateToComments} aria-label={commentLabel}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        <path d="M21 11c0 4.4-4 8-9 8H9l-4 3v-5C3.1 15.5 2 13.4 2 11c0-4.4 4.3-8 9.5-8S21 6.6 21 11Z" />
      </svg><span aria-hidden="true">{dynamic.commentCount ?? '—'}</span></button>}
    </div>
  </>;
}

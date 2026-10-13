import type { ArchiveWorkState, Dynamic, User } from '../data/contracts';
import styles from './Dynamics.module.css';
import { FoldableText } from './FoldableText';
import { ImageGrid } from '../images/ImageGrid';
import { UserAvatar } from './UserAvatar';

export function Identity({ user }: { user: User }) {
  return <div className={styles.identity} data-display-identity>
    <UserAvatar user={user} className={styles.avatar} />
    <span className={styles.nickname}>{user.nickname ?? '未知用户'}</span>
  </div>;
}

function workLabel(state: ArchiveWorkState, complete: string, pending: string): string {
  if (state === 'success') return complete;
  if (state === 'pending') return pending;
  return state === 'failed' ? '读取失败' : '受限';
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
  const retainedMessage = dynamic.text.trim() ? '已保存内容仍可阅读。' : '已有归档状态未覆盖。';
  const commentLabel = `${archive ? '来源评论' : '评论'} ${dynamic.commentCount ?? '—'}`;
  return <>
    <Identity user={dynamic.author} />
    {archive?.title && <h2 className={styles.text}>{archive.title}</h2>}
    <time className={styles.time} dateTime={dynamic.publishedAt ?? undefined}>{displayTime(dynamic.publishedAt)}</time>
    {archive && <>
      {archive.editedAt && <p className={styles.time}>编辑于 {displayTime(archive.editedAt).slice(0, 16)}</p>}
      {archive.editStatus === 'unknown' && <p className={styles.time}>编辑信号未知。</p>}
      {archive.editStatus === 'error' && <p className={styles.time}>编辑信号读取或解析失败；保留已有可信时间。</p>}
      {archive.contentState === 'restricted' && <p role="status">正文访问受限。</p>}
      {archive.contentState === 'failed' && <p role="status">正文尚未成功归档。</p>}
      {archive.contentState === 'success' && archive.lastAttempt === 'failed' && <p role="status">最近正文读取失败；{retainedMessage}</p>}
      {archive.contentState === 'success' && archive.lastAttempt === 'restricted' && <p role="status">最近正文访问受限；{retainedMessage}</p>}
      {!!archive.mediaSources.length && <p role="status">图片待归档（{archive.mediaSources.length} 张）。</p>}
      <p className={styles.count}>本地已归档一级评论：{archive.localCommentCount}</p>
      <p className={styles.count}>本地已归档回复：{archive.localReplyCount ?? '—'}</p>
      <p className={styles.count}>正文{workLabel(archive.work.text, '已保存', '待同步')}；媒体{workLabel(archive.work.media, '已归档', '待归档')}；评论{workLabel(archive.work.comments, '已归档', '待归档')}。</p>
    </>}
    {text && (folding ? <FoldableText text={text} expanded={folding.expanded} toggle={folding.toggle} />
      : <p className={styles.text}>{text}</p>)}
    {!!dynamic.images?.length && <ImageGrid images={dynamic.images} list={!!folding} />}
    {navigateToComments ? <button className={`${styles.button} ${styles.commentEntry}`} type="button" onClick={navigateToComments}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" />
        <path d="M7 9h10M7 13h7" />
      </svg>{commentLabel}</button>
      : <p className={styles.count}>{commentLabel}</p>}
  </>;
}

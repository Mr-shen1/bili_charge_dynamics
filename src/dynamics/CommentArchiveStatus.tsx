import type { ArchiveMetadata } from '../data/contracts';
import { displayTime } from './DynamicContent';
import { commentSyncErrors } from '../data/commentSyncErrors';
import { commentProgress, type CommentProgress } from '../data/commentProgress';
import styles from './Dynamics.module.css';

const progressLabels: Record<CommentProgress, string> = {
  unchecked: '评论未检查，待处理。',
  complete: '本轮评论文本已完成；不代表拥有完整来源评论或实时更新。',
  running: '评论同步中；已有归档仍可阅读。',
  'partial-failed': '评论部分完成，最近同步失败，待后台重试。',
  failed: '评论同步失败，待后台重试。',
  partial: '评论部分完成，其余待处理。',
  unconfirmed: '评论待处理或尚未确认；读取成功不代表采集完成。',
  pending: '评论待处理或尚未确认；读取成功不代表采集完成。',
};

export function CommentArchiveStatus({ archive, sourceCount, loaded }: {
  archive: ArchiveMetadata; sourceCount: number | null; loaded: number;
}) {
  const check = archive.commentSync;
  const state = progressLabels[commentProgress(check ?? {
    parts: { comments: archive.work.comments, replies: archive.work.replies ?? 'pending' },
    commentsLastAttempt: archive.rootCommentsLastAttempt === 'failed' || archive.repliesLastAttempt === 'failed'
      ? 'failed' : archive.commentsLastAttempt,
  })];
  return <aside className={styles.status} aria-label="评论归档状态">
    <p>来源评论总数：{sourceCount ?? '—'}；本地一级评论：{check?.localCommentCount ?? archive.localCommentCount}；本地回复：{check?.localReplyCount ?? archive.localReplyCount ?? '—'}；当前已加载一级评论：{loaded}。</p>
    <p role="status">{state}</p>
    {check && <>
      <p>根评论最近成功：{check.rootCommentsLastSucceededAt ? displayTime(check.rootCommentsLastSucceededAt) : '—'}</p>
      <p>回复最近成功：{check.repliesLastSucceededAt ? displayTime(check.repliesLastSucceededAt) : '—'}</p>
      <p>评论整轮最近成功：{check.commentsLastSucceededAt ? displayTime(check.commentsLastSucceededAt) : '—'}</p>
      <p>历史成功时间不代表当前观察已完成；未知时间不补造。</p>
      {check.commentsError && <p role="status">评论整轮：{commentSyncErrors[check.commentsError]}</p>}
    </>}
    {check?.commentCountStatus === 'failed' && <p role="status">来源计数最近读取失败；保留旧可信值，不表示零。</p>}
    {check && <p>最近检查：{check.lastCheckedAt ? displayTime(check.lastCheckedAt) : '未检查'}；检查无变化不代表同步成功。</p>}
    {check ? check.parts.comment_media !== 'success' && <p>{check.parts.comment_media === 'failed' ? '评论图片归档失败' : '评论图片待处理'}；评论文本完成不代表图片完成。</p>
      : <p>评论图片状态尚未确认；评论文本完成不代表图片完成。</p>}
    <p>数量增删抵消或纯评论编辑但总数不变可能漏检；不保证所有受限评论可读。</p>
  </aside>;
}

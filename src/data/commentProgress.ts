import type { TargetCheck } from './checkStatus';

interface CommentProgressSignals {
  readonly checkStatus?: TargetCheck['checkStatus'];
  readonly work?: TargetCheck['work'];
  readonly parts: Pick<TargetCheck['parts'], 'comments' | 'replies'>;
  readonly commentsLastAttempt?: TargetCheck['commentsLastAttempt'];
  readonly rootCommentsError?: TargetCheck['rootCommentsError'];
  readonly repliesError?: TargetCheck['repliesError'];
  readonly commentsError?: TargetCheck['commentsError'];
}
export type CommentProgress = 'unchecked' | 'complete' | 'running' | 'partial-failed' | 'partial' | 'failed' | 'unconfirmed' | 'pending';

/** 仅依据评论分项；正文/媒体的聚合错误不能冒充评论失败。 */
export function commentProgress(signals: CommentProgressSignals): CommentProgress {
  const parts = [signals.parts.comments, signals.parts.replies];
  const errors = [signals.rootCommentsError, signals.repliesError, signals.commentsError];
  const failed = parts.includes('failed') || signals.commentsLastAttempt === 'failed'
    || errors.some(error => error === 'ROOT_COMMENTS_FAILED' || error === 'REPLIES_FAILED');
  if (signals.checkStatus === 'unchecked') return 'unchecked';
  if (parts.every(part => part === 'success')) return 'complete';
  if (signals.work === 'running') return 'running';
  if (parts.includes('success')) return failed ? 'partial-failed' : 'partial';
  if (failed) return 'failed';
  if (signals.commentsLastAttempt === 'unconfirmed' || errors.includes('COMMENT_LOCATOR_UNCONFIRMED')) return 'unconfirmed';
  return 'pending';
}

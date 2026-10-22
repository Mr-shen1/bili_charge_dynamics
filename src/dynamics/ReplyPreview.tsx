import type { Reply } from '../data/contracts';
import { Identity } from './DynamicContent';
import { replyBodyText } from './replyText';
import { ReadOnlyLikeCount } from './ReadOnlyLikeCount';
import styles from './Dynamics.module.css';

/** 手机端楼中楼预览：只展示作者在该楼里的一条回复；作者未参与时不占位。 */
export function ReplyPreview({ upReply, authorId, replyCount, onOpen }: {
  upReply: Reply | null | undefined; authorId: string; replyCount: number | null; onOpen(): void;
}) {
  if (replyCount === null || replyCount < 1) return null;
  return <div className={styles.replyPreview}>
    {upReply && <div className={styles.replyPreviewBox}>
      <p className={styles.replyPreviewLine}>
        <Identity user={upReply.author} inline />{' '}
        {upReply.author.id === authorId && <><span className={styles.upBadge}>UP</span>{' '}</>}
        {upReply.replyTo?.nickname && <><span className={styles.replyPreviewTarget}>回复 {upReply.replyTo.nickname}:</span>{' '}</>}
        <span className={styles.replyPreviewText}>{replyBodyText(upReply.text).trim() || '暂无评论内容'}</span>
      </p>
      <div className={styles.metrics}><ReadOnlyLikeCount count={upReply.likeCount} /></div>
    </div>}
    <button type="button" className={styles.threadEntry} onClick={onOpen}>
      {upReply ? 'UP主等人 ' : ''}共{replyCount}条回复<span aria-hidden="true" className={styles.threadChevron}>›</span>
    </button>
  </div>;
}

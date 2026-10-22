import { useCompactViewport } from '../app/useCompactViewport';
import styles from './Dynamics.module.css';

/** 楼中楼分页与 B站一致：每页 10 条。 */
export const replyPageSize = 10;

export function replyPageCount(total: number | null | undefined, loaded: number, nextCursor?: string | null): number {
  // 游标结束后的实际条数优先；来源计数可能包含本地不可读的回复。
  const count = nextCursor === null ? loaded : Math.max(total ?? loaded, loaded + (nextCursor ? 1 : 0), 0);
  return Math.max(1, Math.ceil(count / replyPageSize));
}

/** 桌面显示当前页及前后各两页，保留首尾页；窄屏使用精简窗口。 */
export function replyPageEntries(page: number, pages: number, compact = false): readonly (number | '…')[] {
  if (pages <= (compact ? 4 : 6)) return Array.from({ length: pages }, (_, index) => index + 1);
  if (compact) {
    if (page >= pages - 1) return [1, '…', pages - 2, pages - 1, pages];
    return page <= 2 ? [1, 2, 3, '…', pages] : [1, '…', page, '…', pages];
  }
  const start = Math.max(1, Math.min(page - 2, pages - 4));
  const end = start + 4;
  return [
    ...(start > 1 ? [1, ...(start > 2 ? ['…' as const] : [])] : []),
    ...Array.from({ length: 5 }, (_, index) => start + index),
    ...(end < pages ? [...(end < pages - 1 ? ['…' as const] : []), pages] : []),
  ];
}

export function ReplyPager({ page, pages, busy, onSelect, onCollapse, collapseLabel = '收起' }: {
  page: number; pages: number; busy: boolean; onSelect(page: number): void;
  onCollapse(): void; collapseLabel?: string;
}) {
  const compact = useCompactViewport();
  return <nav className={styles.replyPager} aria-label="回复分页">
    <span className={styles.pagerTotal}>共{pages}页</span>
    {page > 1 && <button type="button" className={styles.pagerAction} disabled={busy}
      onClick={() => onSelect(page - 1)}>上一页</button>}
    {replyPageEntries(page, pages, compact).map((entry, index) => entry === '…'
      ? <span key={`gap-${index}`} className={styles.pagerGap} aria-hidden="true">…</span>
      : <button key={entry} type="button" className={styles.pagerPage}
        aria-current={entry === page ? 'page' : undefined} disabled={busy}
        onClick={() => onSelect(entry)}>{entry}</button>)}
    <button type="button" className={styles.pagerAction} disabled={busy || page >= pages}
      aria-busy={busy || undefined}
      onClick={() => onSelect(Math.min(page + 1, pages))}>下一页</button>
    <button type="button" className={styles.pagerAction} onClick={onCollapse}>{collapseLabel}</button>
  </nav>;
}

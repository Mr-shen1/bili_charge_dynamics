import { replyAppendSize } from '../data/contracts';

/** 楼中楼页码模式固定每页 10 条；与后端 page 模式的固定 limit 一致。 */
export const replyPageSize = replyAppendSize;

/**
 * 末页只由本地回复总数决定：`count`/`localReplyCount` 是本地完整回复量，
 * 未知时才退回已读条数。`nextCursor` 恒为 null，不能用来判断“没有其他页”。
 */
export function replyPageCount(localTotal: number | null | undefined, loaded: number): number {
  const total = localTotal ?? loaded;
  return Math.max(1, Math.ceil(total / replyPageSize));
}

/** 桌面显示当前页及前后各两页，保留首尾页；窄屏使用精简窗口。 */
export function replyPageEntries(page: number, pages: number, compact = false): readonly (number | '…')[] {
  if (pages <= (compact ? 4 : 6)) return Array.from({ length: pages }, (_value, index) => index + 1);
  if (compact) {
    if (page >= pages - 1) return [1, '…', pages - 2, pages - 1, pages];
    return page <= 2 ? [1, 2, 3, '…', pages] : [1, '…', page, '…', pages];
  }
  const start = Math.max(1, Math.min(page - 2, pages - 4));
  const end = start + 4;
  return [
    ...(start > 1 ? [1, ...(start > 2 ? ['…' as const] : [])] : []),
    ...Array.from({ length: 5 }, (_value, index) => start + index),
    ...(end < pages ? [...(end < pages - 1 ? ['…' as const] : []), pages] : []),
  ];
}

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

/**
 * 页码窗口：宽窄屏同一口径——保留首尾页，当前页居中取 5 页窗，断开处用省略号，
 * 例如第 39 页 / 共 46 页是 `1 … 37 38 39 40 41 … 46`。
 * 页数不超过 6 时直接全列，不再用省略号省空间。
 */
export function replyPageEntries(page: number, pages: number): readonly (number | '…')[] {
  if (pages <= 6) return Array.from({ length: pages }, (_value, index) => index + 1);
  const start = Math.max(1, Math.min(page - 2, pages - 4));
  const end = start + 4;
  return [
    ...(start > 1 ? [1, ...(start > 2 ? ['…' as const] : [])] : []),
    ...Array.from({ length: 5 }, (_value, index) => start + index),
    ...(end < pages ? [...(end < pages - 1 ? ['…' as const] : []), pages] : []),
  ];
}

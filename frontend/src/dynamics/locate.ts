import type { LocateStatus, ReadStatus } from '../data/contracts';

/**
 * 只在确实读到的条目里确认目标：目标不在当前批次时返回 null，
 * 绝不用列表顶部或楼层开头冒充“定位成功”。
 */
export function confirmedTarget(
  target: string | null | undefined,
  items: readonly { readonly id: string }[] | undefined,
): string | null {
  return target && items?.some(item => item.id === target) ? target : null;
}

/**
 * 目标不存在有自己的提示与返回入口：通用读取提示把它当成功，
 * 不冒充读取失败，也不额外叠一条错误。
 */
export function noticeStatus(status: LocateStatus): ReadStatus {
  return status === 'not-found' ? 'success' : status;
}

/** “目标不存在”只对声明了目标的精确入口成立，普通读取没有这个结论。 */
export function targetMissing(
  target: string | null | undefined,
  status: LocateStatus,
): boolean {
  return Boolean(target) && status === 'not-found';
}

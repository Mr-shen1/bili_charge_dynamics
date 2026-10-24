import { assembly } from './assembly';

/**
 * 读取失败统一折叠为 `status:'error'`，不向用户暴露内部原因；
 * 但在非生产装配下记录原始异常，避免编程错误（例如未定义变量）
 * 被静默吞掉后只看到“读取失败”。生产装配保持安静。
 */
export function reportReadError(
  area: string,
  error: unknown,
  enabled: boolean = assembly.kind !== 'production',
): void {
  if (!enabled) return;
  console.error(`[read] ${area}读取异常`, error);
}

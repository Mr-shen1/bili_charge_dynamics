/** 带明确时区的执行时间；拒绝日历滚动，不把来源分钟时间补秒。 */
export function timestamp(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return false;
  const zone = value.endsWith('Z') ? null : value.slice(-6);
  const offset = zone ? (zone[0] === '+' ? 1 : -1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4))) : 0;
  return new Date(epoch + offset * 60_000).toISOString().slice(0, 19) === value.slice(0, 19);
}

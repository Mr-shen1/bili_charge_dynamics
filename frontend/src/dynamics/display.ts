/** 展示层格式化：时间与计数保持当前归档语义，未知不猜值。 */
export function displayTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未知';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

/** 零是有效计数，未知才显示占位符。 */
export function displayCount(value: number | null): string {
  return value === null ? '—' : String(value);
}

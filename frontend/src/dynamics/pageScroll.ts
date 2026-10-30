/**
 * 翻页落点：把某一页的第一条回复放到视口顶部，让用户从这一页的开头开始读。
 * 只在用户主动点分页器后调用；首次读取、历史恢复与精确定位各有自己的落点，不走这里。
 */
export function alignFirstReply(root: HTMLElement | null): void {
  const first = root?.querySelector<HTMLElement>('[data-reading-id]');
  if (!first) return;
  const top = Math.max(0, window.scrollY + first.getBoundingClientRect().top);
  window.scrollTo?.({ top, left: 0, behavior: 'instant' });
}

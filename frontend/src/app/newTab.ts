/**
 * 桌面正文入口：在独立标签页打开详情地址。
 *
 * 新标签页只依赖 URL 与只读接口，因此不复制原列表的内存快照，也不需要后者的来源关系；
 * `noopener` 让新标签拿不到 `window.opener`（既读不到也不写不了原列表状态），
 * 同时按 `noreferrer` 不把来源地址交给详情页。少数实现仍会返回窗口引用，
 * 这里再显式断开一次，隔离效果不依赖浏览器对特性串的解释。
 */
export function openInNewTab(url: string): void {
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (opened) opened.opener = null;
}

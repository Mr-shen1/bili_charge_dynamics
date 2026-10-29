import { watch, type ComputedRef } from 'vue';

/** 入口 HTML 的静态标题：不在映射内的页面沿用，不把阅读改版的名称强加给其他页面。 */
export const baseDocumentTitle = '充电动态';

/**
 * 浏览器标签标题：由路由身份决定，直达、刷新、复制地址与新标签都得到同一结果，
 * 不只修改某一次点击。
 *
 * 精确入口与普通详情是同一张详情页，所以标题同为“动态详情”（定位意图由页面与导航决定，
 * 不靠标题重写）；独立楼中楼（含回复精确入口）与只读会话页各有自己的身份名称。
 */
const titles: Readonly<Record<string, string>> = {
  detail: '动态详情',
  'comment-locate': '动态详情',
  'reply-locate': '回复详情',
  thread: '回复详情',
  conversation: '会话列表',
  manage: '监控管理',
  'manage-up': '监控管理',
  'not-found': '页面不存在',
};

export function documentTitleFor(routeName: unknown): string {
  return typeof routeName === 'string' ? titles[routeName] ?? baseDocumentTitle : baseDocumentTitle;
}

/** 跟随路由设置标签标题；同一路由内的参数变化不改标题。 */
export function useDocumentTitle(routeName: ComputedRef<unknown>): void {
  watch(routeName, name => { document.title = documentTitleFor(name); }, { immediate: true });
}

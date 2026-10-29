import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { baseDocumentTitle, documentTitleFor } from '../../src/app/documentTitle';

// 标签标题由路由身份决定：直达、刷新与新标签都得到同一结果，不依赖某次点击。
it('详情与两个精确入口共用“动态详情”，回复详情与会话各有自己的名称', () => {
  expect(documentTitleFor('detail')).toBe('动态详情');
  expect(documentTitleFor('comment-locate')).toBe('动态详情');
  expect(documentTitleFor('reply-locate')).toBe('回复详情');
  expect(documentTitleFor('thread')).toBe('回复详情');
  expect(documentTitleFor('conversation')).toBe('会话列表');
});

it('列表页签沿用当前动态用语，不再称归档；管理页保留自己的名称', () => {
  // 设计 §2：应用生成的可见文案不再把阅读范围叫“归档”，列表页签也是同一套用语。
  expect(baseDocumentTitle).toBe('充电动态');
  expect(baseDocumentTitle).not.toContain('归档');
  expect(documentTitleFor('list')).toBe('充电动态');
  expect(documentTitleFor('up-list')).toBe('充电动态');
  expect(documentTitleFor(undefined)).toBe('充电动态');
  expect(documentTitleFor('manage')).toBe('监控管理');
});

it('入口 HTML 的静态标题与列表页兜底标题一致：首屏加载或读取失败也不露出旧名称', () => {
  // 入口静态 title 在应用挂载前与 fallback 路由（列表/单 UP）都可见，必须与路由标题同一用语。
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../index.html'), 'utf8');
  expect(html).toContain(`<title>${baseDocumentTitle}</title>`);
});

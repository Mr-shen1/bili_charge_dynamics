import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createArchiveReader } from '../../src/data/archiveReader';
import { archiveComment } from '../fixtures/comments';
import { archiveDynamic, archiveMedia, archiveUser } from '../fixtures/archive';
import { settle, showApp } from '../support/app';
import { installFakeLayout, type FakeLayout } from '../support/layout';
import { installCompactViewport, removeCompactViewport } from '../support/viewport';

// 卡片正文入口：宽屏在独立标签页打开详情，原列表与内联评论状态原样保留；
// 窄屏仍是站内进入详情顶部。内部控件、文字选择与组合键/中键都不重复开窗。
// 读取经由生产 Adapter 的 DTO 映射；新标签本身由浏览器用例取证，这里只固定页面决策。

let layout: FakeLayout;
let open: ReturnType<typeof vi.fn>;
beforeEach(() => {
  layout = installFakeLayout();
  open = vi.fn(() => null);
  vi.stubGlobal('open', open);
});
afterEach(() => {
  cleanup();
  layout.restore();
  removeCompactViewport();
  vi.unstubAllGlobals();
});

/** 两张动态 + 一级评论；详情按 ID 返回同一条域数据，便于断言新标签地址。 */
function transport(options: { failDetail?: boolean; missingDetail?: boolean } = {}) {
  const reader = createArchiveReader(async url => {
    if (url === '/api/archive/ups') return Response.json({ ups: [archiveUser('123', '归档作者')] });
    const comments = /^\/api\/archive\/dynamics\/([^/?]+)\/comments\?/.exec(url);
    if (comments) {
      const dynamicId = comments[1]!;
      return Response.json({
        items: [archiveComment(1, { dynamic_id: dynamicId, text: `${dynamicId} 的一级评论` })],
        next_cursor: null,
      });
    }
    const detail = /^\/api\/archive\/dynamics\/([^/?]+)$/.exec(url);
    if (detail) {
      if (options.failDetail) return Response.json({ error: { code: 'INTERNAL' } }, { status: 500 });
      if (options.missingDetail) return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
      return Response.json(archiveDynamic(Number(detail[1]!.slice(3))));
    }
    return Response.json({
      items: [
        archiveDynamic(1, {
          source_comment_count: 5,
          local_comment_count: 5,
          text: '可点击正文 1',
          media: archiveMedia('1001', 2),
        }),
        archiveDynamic(2, { text: '可点击正文 2' }),
      ],
      next_cursor: null,
    });
  });
  return reader;
}

function card(index: number): HTMLElement {
  return screen.getAllByRole('article')[index]!;
}

it('宽屏点击正文在独立标签打开详情，原列表 URL 与内联评论状态都不变', async () => {
  const router = await showApp(transport());
  await screen.findByText('可点击正文 1');

  // 先展开第一张卡片的一级评论并切到热度：新标签不得重置这些状态。
  await fireEvent.click(within(card(0)).getByRole('button', { name: '来源评论 5' }));
  const region = within(card(0)).getByRole('region', { name: '评论区' });
  await within(region).findByText('1001 的一级评论');
  await fireEvent.click(within(region).getByRole('button', { name: '当前按时间，点击切换为按热度' }));
  await within(region).findByText('1001 的一级评论');
  const before = router.currentRoute.value.fullPath;

  await fireEvent.click(screen.getByText('可点击正文 1'));

  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith('/dynamics/1001', '_blank', expect.stringContaining('noopener'));
  expect(router.currentRoute.value.fullPath).toBe(before);
  expect(within(card(0)).getByRole('button', { name: '当前按热度，点击切换为按时间' })).toBeTruthy();
  expect(within(card(0)).getByText('1001 的一级评论')).toBeTruthy();
});

it('宽屏卡片链接自带新标签与 opener 隔离，地址可直接读取', async () => {
  await showApp(transport());
  await screen.findByText('可点击正文 1');
  const link = screen.getByRole('link', { name: '阅读全文 1001' });
  expect(link.getAttribute('href')).toBe('/dynamics/1001');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener');
});

it('窄屏卡片链接与正文都在站内进入详情顶部，不新开标签', async () => {
  installCompactViewport(true);
  const router = await showApp(transport());
  await screen.findByText('可点击正文 1');
  expect(screen.getByRole('link', { name: '阅读全文 1001' }).getAttribute('target')).toBeNull();

  await fireEvent.click(screen.getByText('可点击正文 1'));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  expect(router.currentRoute.value.fullPath).toBe('/dynamics/1001');
  expect(open).not.toHaveBeenCalled();
  expect(await screen.findByRole('article')).toBeTruthy();
});

it('组合键、中键与文字选择都不重复开窗', async () => {
  await showApp(transport());
  const text = await screen.findByText('可点击正文 1');

  await fireEvent.click(text, { button: 1 });
  await fireEvent.click(text, { ctrlKey: true });
  await fireEvent.click(text, { metaKey: true });
  await fireEvent.click(text, { shiftKey: true });
  expect(open).not.toHaveBeenCalled();

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(text);
  selection?.removeAllRanges();
  selection?.addRange(range);
  await fireEvent.click(text);
  expect(open).not.toHaveBeenCalled();
  selection?.removeAllRanges();
});

it('图片、作者展示与评论入口都不抢正文导航', async () => {
  const router = await showApp(transport());
  await screen.findByText('可点击正文 1');

  await fireEvent.click(within(card(0)).getByRole('button', { name: '预览动态图片 1' }));
  await fireEvent.click(within(card(0)).getByText('归档作者'));
  await fireEvent.click(within(card(0)).getByRole('button', { name: '来源评论 5' }));
  expect(open).not.toHaveBeenCalled();
  expect(router.currentRoute.value.path).toBe('/');

  // 评论正文是卡片内联区的内部操作，同样不导航正文。
  const region = within(card(0)).getByRole('region', { name: '评论区' });
  await fireEvent.click(await within(region).findByText('1001 的一级评论'));
  expect(open).not.toHaveBeenCalled();
  expect(router.currentRoute.value.path).toBe('/');
});

it('宽屏正常详情没有可见页头和返回按钮，窄屏只留一个 ‹ 动态列表', async () => {
  await showApp(transport(), '/dynamics/1001');
  await screen.findByText('归档正文 1');
  expect(document.querySelector('.detail-title')).toBeNull();
  expect(screen.queryByRole('button', { name: '‹ 动态列表' })).toBeNull();
  expect(screen.queryByRole('button', { name: '返回列表' })).toBeNull();

  cleanup();
  installCompactViewport(true);
  await showApp(transport(), '/dynamics/1001');
  await screen.findByText('归档正文 1');
  expect(document.querySelector('.detail-title')).toBeNull();
  expect(screen.getAllByRole('button', { name: '‹ 动态列表' })).toHaveLength(1);
});

it('读取失败与地址无效仍保留重试和退出入口', async () => {
  await showApp(transport({ failDetail: true }), '/dynamics/1001');
  expect((await screen.findByRole('alert')).textContent).toBe('动态详情读取失败，请重试。');
  expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '‹ 动态列表' })).toBeTruthy();

  cleanup();
  await showApp(transport({ missingDetail: true }), '/dynamics/1001');
  expect(await screen.findByText('动态不存在或不可用')).toBeTruthy();
  expect(screen.getByRole('button', { name: '‹ 动态列表' })).toBeTruthy();
});

it('窄屏有来源返回对应列表，无来源返回全部动态', async () => {
  installCompactViewport(true);
  const router = await showApp(transport(), '/ups/123');
  await screen.findByText('可点击正文 1');
  layout.setScrollY(700);

  await fireEvent.click(screen.getByText('可点击正文 1'));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  await settle();
  await fireEvent.click(screen.getByRole('button', { name: '‹ 动态列表' }));
  await waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/ups/123'));
  await waitFor(() => expect(layout.scrollY()).toBe(700));

  // 直达/刷新没有来源：退出替换为全部动态，不留在详情页，也不盲目离站。
  cleanup();
  const direct = await showApp(transport(), '/dynamics/1002');
  await screen.findByText('归档正文 2');
  await fireEvent.click(screen.getByRole('button', { name: '‹ 动态列表' }));
  await waitFor(() => expect(direct.currentRoute.value.fullPath).toBe('/'));
});

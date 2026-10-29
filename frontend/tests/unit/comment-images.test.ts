import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DynamicImage } from '../../src/data/contracts';
import { comment, commentDynamic, commentImages } from '../fixtures/comments';
import type { ImagePreviewCoordinator } from '../../src/preview/useImagePreview';
import { createReader } from '../support/reader';
import { showApp } from '../support/app';
import { installFakeLayout, type FakeLayout } from '../support/layout';

let layout: FakeLayout;
beforeEach(() => { layout = installFakeLayout(); });
afterEach(() => {
  cleanup();
  layout.restore();
});

function readerWith(items: readonly ReturnType<typeof comment>[]) {
  return createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async () => ({ status: 'success', data: { items, nextCursor: null } }),
  });
}

it('一级评论图片按评论 owner 渲染为独立预览组，顺序与所点索引正确', async () => {
  const images = commentImages(comment(1).id, 4);
  await showApp(readerWith([comment(1, { images })]), '/dynamics/1001');

  const region = await screen.findByRole('region', { name: '评论区' });
  const item = (await within(region).findAllByRole('listitem'))[0]!;
  const group = within(item).getByRole('group', { name: '评论图片' });
  expect(group.getAttribute('data-image-group')).toBe(`comment-${comment(1).id}`);
  const tiles = within(group).getAllByRole('button', { name: /^预览评论图片 / });
  expect(tiles.map(tile => tile.getAttribute('aria-label'))).toEqual([
    '预览评论图片 1', '预览评论图片 2', '预览评论图片 3', '预览评论图片 4',
  ]);

  await fireEvent.click(tiles[2]!);
  await waitFor(() => expect(screen.getByTestId('preview-session').textContent)
    .toBe(`comment-${comment(1).id}:2/4`));
});

it('未提供 media 的旧评论不渲染图片组，仍按待归档数量提示', async () => {
  await showApp(readerWith([{ ...comment(1), text: '', images: [], pendingMediaCount: 2 }]), '/dynamics/1001');

  const region = await screen.findByRole('region', { name: '评论区' });
  const item = (await within(region).findAllByRole('listitem'))[0]!;
  expect(within(item).queryByRole('group', { name: '评论图片' })).toBeNull();
  expect(item.textContent).toContain('评论图片待归档（2 张）');
  expect(item.textContent).not.toContain('暂无评论内容');
});

it('评论多于九张时只展示前九张，末张仍可进入完整组且索引正确', async () => {
  const images = commentImages(comment(1).id, 12);
  await showApp(readerWith([comment(1, { images })]), '/dynamics/1001');

  const region = await screen.findByRole('region', { name: '评论区' });
  const item = (await within(region).findAllByRole('listitem'))[0]!;
  const group = within(item).getByRole('group', { name: '评论图片' });
  const tiles = within(group).getAllByRole('button', { name: /^预览评论图片 / });
  expect(tiles).toHaveLength(9);
  expect(tiles[8]!.getAttribute('aria-label')).toBe('预览评论图片 9，共 12 张');
  // 展示数量只是缩略裁剪：完整组仍为 12 张。
  expect(within(group).getByText('+3')).toBeTruthy();

  await fireEvent.click(tiles[8]!);
  await waitFor(() => expect(screen.getByTestId('preview-session').textContent)
    .toBe(`comment-${comment(1).id}:8/12`));
});

it('动态图与各条根评论的图片组互不混入', async () => {
  const dynamicImages = commentImages('dynamic', 1);
  const first = commentImages(comment(1).id, 2);
  const second = commentImages(comment(2).id, 3);
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic({ images: dynamicImages }) }),
    readComments: async () => ({
      status: 'success',
      data: { items: [comment(1, { images: first }), comment(2, { images: second })], nextCursor: null },
    }),
  });
  const router = await showApp(reader, '/dynamics/1001');

  const region = await screen.findByRole('region', { name: '评论区' });
  const items = await within(region).findAllByRole('listitem');
  const groups = [
    (await screen.findByRole('group', { name: '动态图片' })),
    within(items[0]!).getByRole('group', { name: '评论图片' }),
    within(items[1]!).getByRole('group', { name: '评论图片' }),
  ];
  expect(groups.map(group => group.getAttribute('data-image-group'))).toEqual([
    'dynamic-1001', `comment-${comment(1).id}`, `comment-${comment(2).id}`,
  ]);
  expect(groups.map(group => within(group).getAllByRole('button', { name: /^预览/ }).length)).toEqual([1, 2, 3]);

  await fireEvent.click(within(groups[2]!).getByRole('button', { name: '预览评论图片 2' }));
  await waitFor(() => expect(screen.getByTestId('preview-session').textContent)
    .toBe(`comment-${comment(2).id}:1/3`));

  // 预览一次只属于一个图片组：关闭当前预览后才能打开另一个 owner 的组。
  router.go(-1);
  await waitFor(() => expect(screen.getByTestId('preview-session').textContent).toBe('closed'));
  await fireEvent.click(within(groups[0]!).getByRole('button', { name: '预览动态图片 1' }));
  await waitFor(() => expect(screen.getByTestId('preview-session').textContent).toBe('dynamic-1001:0/1'));
});

it('未上传、归档失败与无效公开地址显示状态占位，不渲染来源业务图', async () => {
  const [ready] = commentImages(comment(1).id, 1);
  const images: DynamicImage[] = [
    ready!,
    { ...ready!, id: `${ready!.id}-pending`, archiveStatus: 'pending', thumbnailUrl: null, previewUrl: null },
    { ...ready!, id: `${ready!.id}-failed`, archiveStatus: 'failed', thumbnailUrl: null, previewUrl: null },
    // 成功状态但没有公开地址：连接层按无效公开地址表达，不回退来源。
    { ...ready!, id: `${ready!.id}-invalid`, thumbnailUrl: null, previewUrl: null },
  ];
  await showApp(readerWith([comment(1, { images })]), '/dynamics/1001');

  const region = await screen.findByRole('region', { name: '评论区' });
  const item = (await within(region).findAllByRole('listitem'))[0]!;
  const group = within(item).getByRole('group', { name: '评论图片' });
  expect(within(group).getByText('图片待归档')).toBeTruthy();
  expect(within(group).getByText('图片归档失败')).toBeTruthy();
  expect(within(group).getByText('归档图片地址不可用')).toBeTruthy();
  // 异常项仍占位为可点缩略图：跳过与关闭不受局部异常阻断。
  expect(within(group).getAllByRole('button', { name: /^预览评论图片 / })).toHaveLength(4);
  // 无效地址不回退来源业务图，也不伪造可加载的图片节点。
  expect(item.querySelector('img[src*="upstream.example.test"]')).toBeNull();

  await fireEvent.click(within(group).getByRole('button', { name: '预览评论图片 2' }));
  await waitFor(() => expect(screen.getByTestId('preview-session').textContent)
    .toBe(`comment-${comment(1).id}:1/4`));
});

it('打开、切图与关闭评论图片预览不重置排序与已加载评论，也不新增历史记录', async () => {
  const images = commentImages(comment(1).id, 4);
  let reads = 0;
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async () => {
      reads += 1;
      return {
        status: 'success',
        data: { items: [comment(1, { images }), comment(2)], nextCursor: null },
      };
    },
  });
  let coordinator!: ImagePreviewCoordinator;
  const router = await showApp(reader, '/dynamics/1001', preview => { coordinator = preview; });

  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(2));
  // 预览不能把用户选过的排序与已加载批次重置回默认。
  await fireEvent.click(within(region).getByRole('button', { name: '当前按时间，点击切换为按热度' }));
  await waitFor(() => expect(within(region).getByRole('button', { name: '当前按热度，点击切换为按时间' })).toBeTruthy());
  const readsBeforePreview = reads;
  const push = vi.spyOn(router, 'push');
  const replace = vi.spyOn(router, 'replace');
  const groupId = `comment-${comment(1).id}`;

  await fireEvent.click(within(region).getByRole('button', { name: '预览评论图片 2' }));
  await waitFor(() => expect(screen.getByTestId('preview-session').textContent).toBe(`${groupId}:1/4`));
  // 同 URL 打开预览只新增一条记录。
  expect(push).toHaveBeenCalledTimes(1);
  expect(router.currentRoute.value.fullPath).toBe('/dynamics/1001');

  replace.mockClear();
  coordinator.switchTo(3);
  await waitFor(() => expect(screen.getByTestId('preview-session').textContent).toBe(`${groupId}:3/4`));
  // 切图只替换同一条记录的索引，不增加历史条目。
  expect(push).toHaveBeenCalledTimes(1);
  expect(replace).toHaveBeenCalledTimes(1);

  router.go(-1);
  await waitFor(() => expect(screen.getByTestId('preview-session').textContent).toBe('closed'));
  const after = screen.getByRole('region', { name: '评论区' });
  expect(within(after).getByRole('button', { name: '当前按热度，点击切换为按时间' })).toBeTruthy();
  expect(within(after).getAllByRole('listitem')).toHaveLength(2);
  // 关闭预览不重读评论，仍停留在当前访问。
  expect(reads).toBe(readsBeforePreview);
  expect(router.currentRoute.value.fullPath).toBe('/dynamics/1001');
});

it('触发缩略图节点被替换后，关闭预览按稳定 ID 找回焦点', async () => {
  const images = commentImages(comment(1).id, 2);
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async () => ({ status: 'success', data: { items: [comment(1, { images })], nextCursor: null } }),
  });
  const router = await showApp(reader, '/dynamics/1001');

  const region = await screen.findByRole('region', { name: '评论区' });
  const tile = await within(region).findByRole('button', { name: '预览评论图片 1' });
  await fireEvent.click(tile);
  await waitFor(() => expect(screen.getByTestId('preview-session').textContent)
    .toBe(`comment-${comment(1).id}:0/2`));

  // 评论列表重挂载会换掉节点：旧引用已断开，但缩略图 ID 稳定。
  const replaced = tile.cloneNode(true) as HTMLElement;
  tile.replaceWith(replaced);
  router.go(-1);
  await waitFor(() => expect(screen.getByTestId('preview-session').textContent).toBe('closed'));
  await waitFor(() => expect(document.activeElement).toBe(replaced));
});

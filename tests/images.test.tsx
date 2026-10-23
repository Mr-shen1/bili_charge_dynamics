import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/app/App';
import { createMockReader } from '../src/data/mockReader';
import { createControlledReader } from '../src/dev/controlledReader';
import type { DynamicReader } from '../src/data/contracts';

const creator = { id: 'up', nickname: '纸飞机', avatarUrl: null };
const image = { id: 'picture', thumbnailUrl: '/images/thumb.v1.svg?signature=a%2Fb&expires=123',
  previewUrl: '/images/full.v1.svg?signature=c%2Fd&expires=123', width: 800, height: 600 };
const dynamic = { id: 'picture-post', author: creator, publishedAt: '2026-03-01T00:00:00Z',
  text: '', commentCount: 0, images: [image] };
function show(count = 1, path = '/', dimensions = { width: 800, height: 600 }) {
  const images = Array.from({ length: count }, (_, index) => ({ ...image, ...dimensions, id: `image-${index}` }));
  return render(<MemoryRouter initialEntries={[path]}><App reader={createMockReader({ creator,
    dynamics: [{ ...dynamic, images }] })} /></MemoryRouter>);
}

describe('动态图片公开页面行为', () => {
  it('长图默认完整显示，键盘可切换适应宽度并保留可关闭的焦点', async () => {
    const user = userEvent.setup();
    show(2, '/', { width: 600, height: 1600 });
    await user.click(await screen.findByRole('img', { name: '图片 1' }));
    const preview = await screen.findByRole('dialog');
    const mode = within(preview).getByRole('button', { name: '适应宽度' });
    expect(mode).toHaveAttribute('aria-pressed', 'false');
    mode.focus();
    await user.keyboard('{Enter}');
    expect(within(preview).getByRole('button', { name: '完整显示' })).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard(' ');
    expect(within(preview).getByRole('button', { name: '适应宽度' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('预览不重建底层列表访问，打开前仍有效的追加可以完成', async () => {
    const user = userEvent.setup();
    let finish!: (result: Awaited<ReturnType<DynamicReader['readList']>>) => void;
    const pending = new Promise<Awaited<ReturnType<DynamicReader['readList']>>>(resolve => { finish = resolve; });
    const reader = createControlledReader(createMockReader({ creator, dynamics: [] }), { list: [
      { result: { status: 'success', data: { items: [dynamic], nextCursor: 'next' } } },
      { result: pending },
    ] });
    render(<MemoryRouter><App reader={reader} /></MemoryRouter>);
    await screen.findByRole('article');
    await user.click(screen.getByRole('button', { name: '加载更多' }));
    await user.click(screen.getByRole('button', { name: '预览图片 1' }));
    await screen.findByRole('dialog');
    finish({ status: 'success', data: { items: [{ ...dynamic, id: 'next', text: '追加已完成', images: [] }], nextCursor: null } });
    await screen.findByText('追加已完成');
    await user.keyboard('{Escape}');
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByText('动态已加载完毕')).toBeVisible();
  });
  it('内容坏图局部占位并重试原地址，仍能打开预览、切图和关闭', async () => {
    const user = userEvent.setup();
    show(4);
    const thumbnail = await screen.findByRole('img', { name: '图片 1' });
    fireEvent.error(thumbnail);
    const card = screen.getByRole('article');
    expect(within(card).getByText('图片加载失败')).toBeVisible();
    await user.click(within(card).getByRole('button', { name: '重试图片 1' }));
    expect(within(card).getByRole('img', { name: '图片 1' })).toHaveAttribute('src', image.thumbnailUrl);
    await user.click(within(card).getByRole('button', { name: '预览图片 1' }));
    const preview = await screen.findByRole('dialog');
    fireEvent.error(within(preview).getByRole('img'));
    expect(within(preview).getByText('图片加载失败')).toBeVisible();
    await user.click(within(preview).getByRole('button', { name: '重试预览图片 1' }));
    expect(within(preview).getByRole('img')).toHaveAttribute('src', image.previewUrl);
    fireEvent.error(within(preview).getByRole('img'));
    await user.click(within(preview).getByRole('button', { name: '下一张' }));
    expect(within(preview).getByRole('img', { name: '预览图片 2' })).toBeVisible();
    expect(within(preview).queryByText('图片加载失败')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('单图隐藏切换按钮，Tab 与 Shift+Tab 在预览内循环', async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('img', { name: '图片 1' }));
    const preview = await screen.findByRole('dialog');
    expect(within(preview).queryByRole('button', { name: '上一张' })).not.toBeInTheDocument();
    expect(within(preview).queryByRole('button', { name: '下一张' })).not.toBeInTheDocument();
    const close = within(preview).getByRole('button', { name: '关闭预览' });
    expect(close).toHaveFocus();
    await user.tab();
    expect(preview).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).not.toBe(close);
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
  });
  it('大图预览可缩放、旋转与还原，点遮罩关闭，切图后变换复位', async () => {
    const user = userEvent.setup();
    show(2);
    await user.click(await screen.findByRole('img', { name: '图片 1' }));
    const preview = await screen.findByRole('dialog');
    // 缩放与旋转作用在承载图片的外框上，不改变 <img> 自身尺寸。
    const picture = () => within(preview).getByRole('img').parentElement!;
    expect(picture().style.transform).toBe('');
    await user.click(within(preview).getByRole('button', { name: '放大' }));
    expect(picture().style.transform).toBe('scale(1.2) rotate(0deg)');
    await user.click(within(preview).getByRole('button', { name: '缩小' }));
    // 回到 1 倍且未旋转时不再保留变换样式。
    expect(picture().style.transform).toBe('');
    await user.click(within(preview).getByRole('button', { name: '向右旋转' }));
    expect(picture().style.transform).toBe('scale(1) rotate(90deg)');
    await user.click(within(preview).getByRole('button', { name: '还原' }));
    expect(picture().style.transform).toBe('');
    await user.click(within(preview).getByRole('button', { name: '放大' }));
    await user.click(within(preview).getByRole('button', { name: '下一张' }));
    expect(picture().style.transform).toBe('');
    // 缩小到下限后按钮禁用，边界不越过。
    const preview2 = screen.getByRole('dialog');
    for (let index = 0; index < 8; index += 1) {
      const zoomOut = within(preview2).getByRole('button', { name: '缩小' });
      if ((zoomOut as HTMLButtonElement).disabled) break;
      await user.click(zoomOut);
    }
    expect(within(preview2).getByRole('button', { name: '缩小' })).toBeDisabled();
    await user.click(within(preview2).getByRole('region', { name: '预览图片阅读区域' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('快速连续方向键仍逐次切图，不因批量渲染丢失输入', async () => {
    const user = userEvent.setup();
    show(4);
    await user.click(await screen.findByRole('img', { name: '图片 1' }));
    const preview = await screen.findByRole('dialog');
    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowRight' });
      fireEvent.keyDown(document, { key: 'ArrowRight' });
      fireEvent.keyDown(document, { key: 'ArrowRight' });
    });
    expect(within(preview).getByText('4 / 4')).toBeVisible();
  });
  it('按钮和方向键按读取顺序切图，首尾不循环，Esc 关闭', async () => {
    const user = userEvent.setup();
    show(4);
    await user.click(await screen.findByRole('img', { name: '图片 1' }));
    const preview = await screen.findByRole('dialog');
    expect(within(preview).getByRole('button', { name: '上一张' })).toBeDisabled();
    await user.keyboard('{ArrowLeft}');
    expect(within(preview).getByText('1 / 4')).toBeVisible();
    await user.click(within(preview).getByRole('button', { name: '下一张' }));
    expect(within(preview).getByText('2 / 4')).toBeVisible();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(within(preview).getByText('4 / 4')).toBeVisible();
    expect(within(preview).getByRole('button', { name: '下一张' })).toBeDisabled();
    await user.click(within(preview).getByRole('button', { name: '上一张' }));
    expect(within(preview).getByText('3 / 4')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it.each(['/', '/dynamics/picture-post'])('从 %s 直接打开对应预览，详情保留全部缩略图', async path => {
    const user = userEvent.setup();
    show(12, path);
    const card = await screen.findByRole('article');
    expect(within(card).getAllByRole('img', { name: /^图片/ })).toHaveLength(path === '/' ? 9 : 12);
    await user.click(within(card).getByRole('img', { name: '图片 3' }));
    const preview = await screen.findByRole('dialog', { name: '图片预览' });
    expect(within(preview).getByText('3 / 12')).toBeVisible();
    expect(within(preview).getByRole('img')).toHaveAttribute('src', image.previewUrl);
    await user.click(within(preview).getByRole('button', { name: '关闭预览' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: '预览图片 3' })).toHaveFocus();
  });
  it.each([4, 9, 12])('列表限制 %i 张图片为最多九个位置并提示剩余数量', async count => {
    show(count);
    const card = await screen.findByRole('article');
    expect(within(card).getAllByRole('img', { name: /^图片/ })).toHaveLength(Math.min(count, 9));
    if (count > 9) expect(within(card).getByText('+3')).toBeVisible();
  });
  it('无正文有图不补正文，缩略图原样使用读取 URL 并预留比例空间', async () => {
    show();
    const card = await screen.findByRole('article');
    expect(within(card).queryByText('暂无内容')).not.toBeInTheDocument();
    const thumbnail = within(card).getByRole('img', { name: '图片 1' });
    expect(thumbnail).toHaveAttribute('src', image.thumbnailUrl);
    expect(thumbnail).toHaveAttribute('loading', 'lazy');
    expect(thumbnail).toHaveAttribute('width', '800');
    expect(thumbnail).toHaveAttribute('height', '600');
  });
});

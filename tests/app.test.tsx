import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/app/App';
import { createMockReader } from '../src/data/mockReader';
import type { DetailResult, DynamicReader } from '../src/data/contracts';
import { createControlledReader } from '../src/dev/controlledReader';

const creator = { id: 'up-1', nickname: '纸飞机', avatarUrl: '/default-avatar.svg' };
const item = {
  id: '90071992547409931', author: creator, publishedAt: '2026-02-03T23:04:05-05:00',
  text: '第一行\n第二行 🙂 https://example.test #话题# @朋友', commentCount: 12345,
};

function show(reader: DynamicReader, path = '/') {
  return render(<MemoryRouter initialEntries={[path]}><App reader={reader} /></MemoryRouter>);
}

function VisitControls() {
  const navigate = useNavigate();
  return <>
    <button onClick={() => void navigate('/', { state: null })}>新列表访问</button>
    <button onClick={() => void navigate(-1)}>历史后退</button>
  </>;
}

describe('文字动态公开页面行为', () => {
  it('同路径的新访问从首批开始，后退只恢复原访问的范围，不共享可变进度', async () => {
    const user = userEvent.setup();
    const reader = createMockReader({ creator, dynamics: Array.from({ length: 25 }, (_, i) => ({
      ...item, id: String(i).padStart(2, '0'), text: `动态 ${i}`,
    })) });
    render(<MemoryRouter><VisitControls /><App reader={reader} /></MemoryRouter>);
    await screen.findAllByRole('article');
    await user.click(screen.getByRole('button', { name: '加载更多' }));
    await screen.findByText('动态 19');
    await user.click(screen.getByRole('button', { name: '新列表访问' }));
    await screen.findByText('动态 0');
    expect(screen.getAllByRole('article')).toHaveLength(10);
    await user.click(screen.getByRole('button', { name: '历史后退' }));
    await screen.findByText('动态 19');
    expect(screen.getAllByRole('article')).toHaveLength(20);
    await user.click(screen.getByRole('button', { name: '加载更多' }));
    await screen.findByText('动态 24');
    expect(screen.getAllByRole('article')).toHaveLength(25);
  });
  it('追加失败保留首批，在原批次重试，随后读完 25 条且不再提供加载入口', async () => {
    const user = userEvent.setup();
    const base = createMockReader({ creator, dynamics: Array.from({ length: 25 }, (_, i) => ({
      ...item, id: String(i).padStart(2, '0'), text: `动态 ${i}`,
    })) });
    show(createControlledReader(base, { list: [{}, { result: { status: 'error' } }] }));
    expect(await screen.findAllByRole('article')).toHaveLength(10);
    await user.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('动态追加读取失败');
    expect(screen.getAllByRole('article')).toHaveLength(10);
    await user.click(screen.getAllByRole('button', { name: '查看详情' })[0]!);
    await user.click(await screen.findByRole('button', { name: '返回列表' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('动态追加读取失败');
    expect(screen.getAllByRole('article')).toHaveLength(10);
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('动态 19')).toBeVisible();
    expect(screen.getAllByRole('article')).toHaveLength(20);
    await user.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('动态 24')).toBeVisible();
    expect(screen.getAllByRole('article')).toHaveLength(25);
    expect(screen.getByText('动态已加载完毕')).toBeVisible();
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
  });
  it('Adapter 批次交界重复 ID 只展示一次，追加取消可重读且不推进标记', async () => {
    const user = userEvent.setup();
    const first = { ...item, id: 'first', text: '首批正文' };
    const next = { ...item, id: 'next', text: '追加正文' };
    show(createControlledReader(createMockReader({ creator, dynamics: [] }), { list: [
      { result: { status: 'success', data: { items: [first], nextCursor: 'opaque-token' } } },
      { result: { status: 'cancelled' } },
      { result: { status: 'success', data: { items: [first, next, next], nextCursor: null } } },
    ] }));
    await screen.findByText('首批正文');
    await user.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('读取已取消，可重新读取。')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '重新读取' }));
    await screen.findByText('追加正文');
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByText('动态已加载完毕')).toBeVisible();
  });
  it.each(['success', 'error', 'rejection'] as const)('重复追加不重复请求，离开后旧 %s 不污染返回的列表，未完成批次可继续读取', async outcome => {
    const user = userEvent.setup();
    const base = createMockReader({ creator, dynamics: Array.from({ length: 25 }, (_, i) => ({
      ...item, id: String(i).padStart(2, '0'), text: `动态 ${i}`,
    })) });
    let resolve!: (value: Awaited<ReturnType<DynamicReader['readList']>>) => void;
    let reject!: (reason: Error) => void;
    const pending = new Promise<Awaited<ReturnType<DynamicReader['readList']>>>((ok, fail) => { resolve = ok; reject = fail; });
    const controlled = createControlledReader(base, { list: [{}, { result: pending, ignoreAbort: true }] });
    const cursors: (string | null | undefined)[] = [];
    show({ ...controlled, readList(input) { cursors.push(input.cursor); return controlled.readList(input); } });
    await screen.findAllByRole('article');
    const more = screen.getByRole('button', { name: '加载更多' });
    fireEvent.click(more);
    fireEvent.click(more);
    expect(more).toBeDisabled();
    expect(cursors).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: '查看详情' })[0]!);
    await screen.findByRole('button', { name: '返回列表' });
    await user.click(screen.getByRole('button', { name: '返回列表' }));
    expect(await screen.findByText('动态 19')).toBeVisible();
    expect(cursors).toHaveLength(3);
    expect(cursors[2]).toBe(cursors[1]);
    await act(async () => {
      if (outcome === 'rejection') reject(new Error('late failure'));
      else resolve(outcome === 'error' ? { status: 'error' } : { status: 'success', data: { items: [{ ...item, id: 'late', text: '过期动态' }], nextCursor: null } });
    });
    expect(screen.getAllByRole('article')).toHaveLength(20);
    expect(screen.queryByText('过期动态')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '加载更多' })).toBeEnabled();
  });
  it('取消的当前读取不当作用户错误，也不遗留永久加载，可重新读取', async () => {
    const user = userEvent.setup();
    const base = createMockReader({ creator, dynamics: [item] });
    show(createControlledReader(base, { detail: { [item.id]: [{ result: { status: 'cancelled' } }] } }), `/dynamics/${item.id}`);
    expect(await screen.findByText('读取已取消，可重新读取。')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新读取' }));
    expect(await screen.findByRole('article')).toBeVisible();
  });
  it('直接打开缺失字段的空正文详情显示准确兜底，不推断删除', async () => {
    const missing = { ...item, author: { ...creator, nickname: null, avatarUrl: null }, publishedAt: null, text: '', commentCount: null };
    show(createMockReader({ creator, dynamics: [missing] }), `/dynamics/${item.id}`);
    const card = await screen.findByRole('article');
    expect(within(card).getByText('暂无内容')).toBeVisible();
    expect(within(card).getByText('未知用户')).toBeVisible();
    expect(within(card).getByRole('img')).toHaveAttribute('src', '/default-avatar.svg');
    expect(within(card).getByText('时间未知')).toBeVisible();
    expect(within(card).getByText('评论 —')).toBeVisible();
  });
  it('开发严格模式下故障装配仍确定性首次失败，重试恢复正常列表', async () => {
    const user = userEvent.setup();
    const reader = createControlledReader(createMockReader({ creator, dynamics: [item] }), {
      list: [{ result: { status: 'error' }, delayMs: 1 }],
    });
    render(<StrictMode><MemoryRouter><App reader={reader} /></MemoryRouter></StrictMode>);
    expect(await screen.findByRole('alert')).toHaveTextContent('动态列表读取失败');
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('article')).toBeVisible();
  });
  it.each(['success', 'error', 'rejection'] as const)('忽略取消的旧详情 %s 不覆盖当前动态或显示用户错误', async outcome => {
    const user = userEvent.setup();
    const old = { ...item, id: 'old', text: '旧动态' };
    const current = { ...item, id: 'current', text: '当前动态' };
    let resolve!: (value: DetailResult) => void;
    let reject!: (reason: Error) => void;
    const delayed = new Promise<DetailResult>((ok, fail) => { resolve = ok; reject = fail; });
    let resolveCurrent!: (value: DetailResult) => void;
    const currentRead = new Promise<DetailResult>(ok => { resolveCurrent = ok; });
    const base = createMockReader({ creator, dynamics: [old, current] });
    show(createControlledReader(base, { detail: {
      old: [{ result: delayed, ignoreAbort: true }], current: [{ result: currentRead }],
    } }));
    await screen.findAllByRole('article');
    const oldCard = screen.getByText('旧动态').closest('article');
    if (!oldCard) throw new Error('Expected old card');
    await user.click(within(oldCard).getByRole('button', { name: '查看详情' }));
    expect(screen.getByRole('status')).toHaveTextContent('动态详情加载中');
    await user.click(screen.getByRole('button', { name: '返回列表' }));
    const currentCard = (await screen.findByText('当前动态')).closest('article');
    if (!currentCard) throw new Error('Expected current card');
    await user.click(within(currentCard).getByRole('button', { name: '查看详情' }));
    expect(screen.getByRole('status')).toHaveTextContent('动态详情加载中');
    await act(async () => {
      if (outcome === 'rejection') reject(new Error('late failure'));
      else resolve(outcome === 'success' ? { status: 'success', data: old } : { status: 'error' });
    });
    expect(screen.getByRole('status')).toHaveTextContent('动态详情加载中');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => { resolveCurrent({ status: 'success', data: current }); });
    expect(screen.getByText('当前动态')).toBeVisible();
    expect(screen.queryByText('旧动态')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('缺失字段与零值分开显示，正文空白不猜测删除，头像失败使用默认头像', async () => {
    const missingUser = { id: 'unknown', nickname: null, avatarUrl: '/broken-avatar.png' };
    show(createMockReader({ creator, dynamics: [
      { ...item, id: 'missing', author: missingUser, publishedAt: 'invalid', text: '  ', commentCount: null },
      { ...item, id: 'zero', commentCount: 0 },
    ] }));
    expect(await screen.findByText('评论 0')).toBeVisible();
    const emptyCard = screen.getByText('暂无内容').closest('article');
    if (!emptyCard) throw new Error('Expected empty content card');
    expect(within(emptyCard).getByText('未知用户')).toBeVisible();
    expect(within(emptyCard).getByText('时间未知')).toBeVisible();
    expect(within(emptyCard).getByText('评论 —')).toBeVisible();
    const avatar = within(emptyCard).getByRole('img');
    fireEvent.error(avatar);
    expect(avatar).toHaveAttribute('src', '/default-avatar.svg');
    expect(screen.queryByText(/已删除|undefined/)).not.toBeInTheDocument();
  });
  it('直达详情首次加载失败可重试，返回入口不依赖站外历史', async () => {
    const user = userEvent.setup();
    const base = createMockReader({ creator, dynamics: [item] });
    show(createControlledReader(base, { detail: { [item.id]: [{ result: { status: 'error' } }] } }), `/dynamics/${item.id}`);
    expect(screen.getByRole('status')).toHaveTextContent('动态详情加载中');
    expect(await screen.findByRole('alert')).toHaveTextContent('动态详情读取失败');
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText(/第二行 🙂/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '返回列表' }));
    expect(await screen.findByRole('button', { name: '查看详情' })).toBeVisible();
  });
  it.each([
    ['/dynamics/missing', '动态不存在或不可用'],
    ['/unknown/page', '未找到页面'],
  ])('无效地址 %s 与普通读取失败分别展示，不提供错误的重试', async (path, message) => {
    const user = userEvent.setup();
    show(createMockReader({ creator, dynamics: [] }), path);
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回列表' }));
    expect(await screen.findByText('暂无动态')).toBeVisible();
  });
  it('列表成功空态不是失败，首次失败在列表区域重试', async () => {
    const user = userEvent.setup();
    const base = createMockReader({ creator, dynamics: [] });
    show(createControlledReader(base, { list: [{ result: { status: 'error' } }] }));
    expect(await screen.findByRole('alert')).toHaveTextContent('动态列表读取失败');
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('暂无动态')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });
  it('只有查看详情触发导航，完整正文安全展示并可返回来源列表', async () => {
    const user = userEvent.setup();
    const text = '第一行\n🙂 https://example.test #话题# @朋友\n<script>window.pwned = true</script>\n<img src=x onerror=alert(1)>\n第五行\n第六行\n第七行';
    show(createMockReader({ creator, dynamics: [{ ...item, text }] }));
    const card = await screen.findByRole('article');
    await user.click(within(card).getByText(/第一行/));
    await user.click(within(card).getByText('纸飞机'));
    await user.click(within(card).getByRole('img'));
    expect(screen.queryByRole('button', { name: '返回列表' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('group', { name: '动态图片' })).not.toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: '查看详情' }));
    expect(await screen.findByRole('heading', { name: '动态详情' })).toBeVisible();
    const detail = await screen.findByRole('article');
    expect(within(detail).getByText(/第七行/).textContent).toBe(text);
    expect(detail.querySelector('script')).toBeNull();
    expect(detail.querySelectorAll('img')).toHaveLength(1);
    expect(within(detail).queryByRole('link')).not.toBeInTheDocument();
    expect(within(detail).queryByRole('group', { name: '动态图片' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回列表' }));
    expect(await screen.findByRole('button', { name: '查看详情' })).toBeVisible();
  });
  it('首次显示加载状态，成功展示身份、北京时间秒值、完整计数及最多十条文字动态', async () => {
    show(createMockReader({ creator, dynamics: Array.from({ length: 12 }, (_, i) => ({
      ...item, id: `dynamic-${i}`, publishedAt: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    })).concat(item) }));
    expect(screen.getByRole('status')).toHaveTextContent('动态列表加载中');
    expect(await screen.findByRole('heading', { name: '纸飞机' })).toBeVisible();
    const cards = await screen.findAllByRole('article');
    expect(cards).toHaveLength(10);
    const card = cards.find(card => within(card).queryByText('2026-02-04 12:04:05'));
    expect(card).toBeDefined();
    if (!card) throw new Error('Expected time in Beijing');
    expect(within(card).getByText('评论 12345')).toBeVisible();
    expect(within(card).getByText(/第二行 🙂/)).toHaveTextContent('https://example.test #话题# @朋友');
    expect(within(card).queryByRole('link')).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: '查看详情' })).toBeVisible();
    expect(screen.queryByText(/关注|简介|充电/)).not.toBeInTheDocument();
  });
});

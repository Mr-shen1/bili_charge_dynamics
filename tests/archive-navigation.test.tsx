import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/app/App';
import { createArchiveReader } from '../src/data/archiveReader';
import { archive } from './fixtures/archive';

const savedUps = [
  { id: '123', nickname: '保留的 UP', avatar_url: 'https://avatars.example.test/saved.png' },
  { id: '456', nickname: null, avatar_url: null },
];

function show(path = '/') {
  const reader = createArchiveReader(async url => {
    if (url === '/api/archive/ups') return Response.json({ ups: savedUps });
    return Response.json({ items: [], next_cursor: null });
  });
  render(<MemoryRouter initialEntries={[path]}><App reader={reader} /></MemoryRouter>);
}

describe('归档 UP 选择条', () => {
  it('身份读取取消不冒充失败，局部重新读取后保留全部入口', async () => {
    const user = userEvent.setup();
    const base = createArchiveReader(async url => Response.json(url.endsWith('/ups')
      ? { ups: savedUps } : { items: [], next_cursor: null }));
    let cancelled = false;
    const reader = { ...base, async readUps(input: Parameters<typeof base.readUps>[0]) {
      if (!cancelled) { cancelled = true; return { status: 'cancelled' as const }; }
      return base.readUps(input);
    } };
    render(<MemoryRouter><App reader={reader} /></MemoryRouter>);
    const nav = within(screen.getByRole('navigation', { name: '归档范围' }));
    expect(await nav.findByText('UP 身份列表读取已取消。')).toBeInTheDocument();
    expect(nav.queryByText('UP 身份列表读取失败。')).not.toBeInTheDocument();
    await user.click(nav.getByRole('button', { name: '重读 UP 列表' }));
    expect(await nav.findByRole('link', { name: '保留的 UP' })).toBeInTheDocument();
    expect(nav.getByRole('link', { name: '全部归档' })).toHaveAttribute('aria-current', 'page');
  });
  it('身份列表读取期间明确提示加载，全部入口仍可使用', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const reader = createArchiveReader(async url => url === '/api/archive/ups'
      ? pending : Response.json({ items: [], next_cursor: null }));
    render(<MemoryRouter><App reader={reader} /></MemoryRouter>);
    const nav = within(screen.getByRole('navigation', { name: '归档范围' }));
    expect(nav.getByRole('status')).toHaveTextContent('UP 身份列表加载中…');
    expect(nav.getByRole('link', { name: '全部归档' })).toHaveAttribute('aria-current', 'page');
    await act(async () => { finish(Response.json({ ups: savedUps })); });
    expect(await nav.findByRole('link', { name: '保留的 UP' })).toBeInTheDocument();
    expect(nav.queryByText('UP 身份列表加载中…')).not.toBeInTheDocument();
  });
  it('键盘可切换保存 UP，点击全部后当前范围回到首页', async () => {
    const user = userEvent.setup();
    show();
    let nav = within(screen.getByRole('navigation', { name: '归档范围' }));
    await nav.findByRole('link', { name: '保留的 UP' });
    await user.tab();
    expect(nav.getByRole('link', { name: '全部归档' })).toHaveFocus();
    await user.tab();
    expect(nav.getByRole('link', { name: '保留的 UP' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await screen.findByRole('heading', { name: 'UP 123 归档' });
    nav = within(screen.getByRole('navigation', { name: '归档范围' }));
    expect(await nav.findByRole('link', { name: '保留的 UP' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: '全部归档' })).not.toHaveAttribute('aria-current');
    await user.click(nav.getByRole('link', { name: '全部归档' }));
    nav = within(screen.getByRole('navigation', { name: '归档范围' }));
    expect(nav.getByRole('link', { name: '全部归档' })).toHaveAttribute('aria-current', 'page');
    expect(await nav.findByRole('link', { name: '保留的 UP' })).not.toHaveAttribute('aria-current');
  });

  it('身份列表失败可局部重读，不清空已显示归档且不回显 HTTP 错误内容', async () => {
    const user = userEvent.setup();
    let failed = false;
    const reader = createArchiveReader(async url => {
      if (url === '/api/archive/ups') {
        if (!failed) { failed = true; throw new Error('SECRET'); }
        return Response.json({ ups: savedUps });
      }
      return Response.json({ items: [{ ...archive, text: '保留的归档正文' }], next_cursor: null });
    });
    render(<MemoryRouter><App reader={reader} /></MemoryRouter>);
    const nav = within(screen.getByRole('navigation', { name: '归档范围' }));
    await waitFor(() => expect(nav.getByRole('status')).toHaveTextContent('UP 身份列表读取失败。'));
    await screen.findByText('保留的归档正文');
    expect(nav.getByRole('link', { name: '全部归档' })).toBeInTheDocument();
    await user.click(nav.getByRole('button', { name: '重读 UP 列表' }));
    expect(await nav.findByRole('link', { name: '保留的 UP' })).toBeInTheDocument();
    expect(screen.getByText('保留的归档正文')).toBeInTheDocument();
    expect(nav.queryByRole('button', { name: '重读 UP 列表' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('SECRET');
  });

  it('头像加载失败改用默认头像，保留昵称、选中状态和单一导航入口', async () => {
    show('/ups/123');
    const nav = within(screen.getByRole('navigation', { name: '归档范围' }));
    const saved = await nav.findByRole('link', { name: '保留的 UP' });
    const avatar = within(saved).getByAltText('');
    fireEvent.error(avatar);
    expect(avatar).toHaveAttribute('src', '/default-avatar.svg');
    expect(saved).toHaveAttribute('aria-current', 'page');
    expect(saved).toHaveAccessibleName('保留的 UP');
    expect(within(saved).queryByRole('button')).not.toBeInTheDocument();
    expect(within(saved).queryByRole('link')).not.toBeInTheDocument();
  });
  it('直接打开单 UP 显示所有保存身份及头像，缺昵称和头像使用既定兜底，选中与范围一致', async () => {
    show('/ups/456');
    const nav = within(screen.getByRole('navigation', { name: '归档范围' }));
    const saved = await nav.findByRole('link', { name: '保留的 UP' });
    expect(within(saved).getByAltText('')).toHaveAttribute('src', 'https://avatars.example.test/saved.png');
    expect(saved).toHaveAttribute('href', '/ups/123');
    expect(saved).not.toHaveAttribute('aria-current');
    const unknown = nav.getByRole('link', { name: '未知用户' });
    expect(unknown).toHaveAttribute('href', '/ups/456');
    expect(unknown).toHaveAttribute('aria-current', 'page');
    expect(within(unknown).getByAltText('')).toHaveAttribute('src', '/default-avatar.svg');
    expect(nav.getByRole('link', { name: '全部归档' })).toHaveAttribute('href', '/');
    expect(nav.getByRole('link', { name: '全部归档' })).not.toHaveAttribute('aria-current');
    expect(nav.getAllByRole('link')).toHaveLength(3);
  });
});

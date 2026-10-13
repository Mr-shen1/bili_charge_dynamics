import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/app/App';
import { createArchiveReader, type ArchiveTransport } from '../src/data/archiveReader';
import { archive } from './fixtures/archive';
import { rootComment } from './fixtures/rootComment';

function show(transport: ArchiveTransport, path = '/') {
  return render(<MemoryRouter initialEntries={[path]}><App reader={createArchiveReader(transport)} /></MemoryRouter>);
}
describe('真实归档基础页面', () => {
  it('生产根评论完整采用服务端顺序20/20/5，失败重读同批、结束不请求，来源零回复不展开', async () => {
    const user = userEvent.setup();
    // 顺序故意与点赞相反；页面不能重排当前批次冒充服务端全局排序。
    const items = Array.from({ length: 45 }, (_, index) => ({ ...rootComment,
      id: String(200 + index), text: `服务端评论 ${index}`, like_count: index, source_reply_count: 0 }));
    const urls: string[] = [];
    let failed = false;
    show(async url => {
      if (!url.includes('/comments?')) return Response.json({ ...archive, local_comment_count: 45,
        local_reply_count: 0, root_comments_last_attempt: 'success', work: { ...archive.work, comments: 'success' } });
      urls.push(url);
      if (url.includes('cursor=second') && !failed) { failed = true; throw new Error('SECRET_TOKEN'); }
      const offset = url.includes('cursor=second') ? 20 : url.includes('cursor=last') ? 40 : 0;
      return Response.json({ items: items.slice(offset, offset + 20), next_cursor: offset === 0 ? 'second' : offset === 20 ? 'last' : null });
    }, `/dynamics/${archive.id}`);
    const area = await screen.findByRole('region', { name: '评论区' });
    await within(area).findByText('服务端评论 19');
    expect(within(area).getAllByRole('listitem')).toHaveLength(20);
    expect(within(area).getAllByRole('listitem')[0]).toHaveTextContent('服务端评论 0');
    expect(within(area).queryByRole('region', { name: /回复区/ })).not.toBeInTheDocument();
    expect(within(area).queryByRole('button', { name: /展开回复/ })).not.toBeInTheDocument();
    await user.dblClick(within(area).getByRole('button', { name: '加载更多评论' }));
    expect(await within(area).findByRole('alert')).toHaveTextContent('最热评论追加读取失败');
    expect(within(area).getAllByRole('listitem')).toHaveLength(20);
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
    await user.click(within(area).getByRole('button', { name: '重试' }));
    await within(area).findByText('服务端评论 39');
    expect(within(area).getAllByRole('listitem')).toHaveLength(40);
    await user.click(within(area).getByRole('button', { name: '加载更多评论' }));
    await within(area).findByText('服务端评论 44');
    expect(within(area).getAllByRole('listitem')).toHaveLength(45);
    expect(within(area).getByText('评论已加载完毕')).toBeVisible();
    expect(within(area).queryByRole('button', { name: '加载更多评论' })).not.toBeInTheDocument();
    expect(urls).toEqual([
      `/api/archive/dynamics/${archive.id}/comments?sort=hot&limit=20`,
      `/api/archive/dynamics/${archive.id}/comments?sort=hot&limit=20&cursor=second`,
      `/api/archive/dynamics/${archive.id}/comments?sort=hot&limit=20&cursor=second`,
      `/api/archive/dynamics/${archive.id}/comments?sort=hot&limit=20&cursor=last`,
    ]);
    expect(screen.getByText('本地已归档回复：0')).toBeVisible();
    expect(screen.getByRole('button', { name: '来源评论 501' })).toBeVisible();
  });
  it.each([
    ['success', '暂无评论'], ['pending', '评论尚未归档'], ['failed', '评论尚未归档'], ['unconfirmed', '评论尚未归档'],
  ] as const)('成功空批在根归档%s状态下区别于未归档，来源未知不补本地数', async (attempt, message) => {
    show(async url => Response.json(url.includes('/comments?') ? { items: [], next_cursor: null }
      : { ...archive, source_comment_count: null, local_reply_count: 0, root_comments_last_attempt: attempt }), `/dynamics/${archive.id}`);
    const area = await screen.findByRole('region', { name: '评论区' });
    expect(await within(area).findByText(new RegExp(message))).toBeVisible();
    expect(within(area).queryByText(attempt === 'success' ? /评论尚未归档/ : '暂无评论')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '来源评论 —' })).toBeVisible();
    expect(screen.getByText('本地已归档一级评论：0')).toBeVisible();
    expect(screen.getByText('本地已归档回复：0')).toBeVisible();
  });
  it('评论图片仅提示未归档，纯图不伪装空正文，不加载来源业务图；未知作者不误标UP', async () => {
    show(async url => Response.json(url.includes('/comments?') ? { items: [{ ...rootComment,
      author: { id: null, nickname: '归档作者', avatar_url: 'javascript:alert(1)' }, text: null,
      media_sources: [{ url: 'https://upstream.example.test/comment.jpg', width: 100, height: 100 }],
    }], next_cursor: null } : { ...archive, local_comment_count: 1 }), `/dynamics/${archive.id}`);
    const area = await screen.findByRole('region', { name: '评论区' });
    expect(await within(area).findByText('评论图片待归档（1 张）。')).toBeVisible();
    expect(within(area).queryByText('暂无评论内容')).not.toBeInTheDocument();
    expect(within(area).queryByText('UP主')).not.toBeInTheDocument();
    expect(within(area).getByRole('img')).toHaveAttribute('src', '/default-avatar.svg');
    expect(document.querySelector('img[src="https://upstream.example.test/comment.jpg"]')).toBeNull();
  });
  it('整卡进入详情，身份和选中文字不导航，移除旧详情按钮并保留独立气泡入口', async () => {
    const user = userEvent.setup();
    show(async url => Response.json(url.endsWith('/ups') ? { ups: [] }
      : url.includes('/comments?') ? { items: [], next_cursor: null }
      : url.includes('?') ? { items: [archive], next_cursor: null } : archive));
    const card = await screen.findByRole('article');
    const entry = within(card).getByRole('link', { name: `阅读全文 ${archive.id}` });
    expect(entry).toHaveAttribute('href', `/dynamics/${archive.id}`);
    expect(within(card).queryByRole('button', { name: '查看详情' })).not.toBeInTheDocument();
    await user.click(within(card).getByText(archive.author.nickname));
    await user.click(within(card).getByRole('img'));
    expect(screen.queryByRole('heading', { name: '动态详情' })).not.toBeInTheDocument();
    const text = within(card).getByText(archive.text.replace(/\s+/g, ' '));
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(text);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe(archive.text);
    fireEvent.click(text);
    expect(screen.queryByRole('heading', { name: '动态详情' })).not.toBeInTheDocument();
    entry.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: '动态详情' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回列表' }));
    selection.removeAllRanges();
    await user.click(screen.getByRole('article'));
    expect(await screen.findByRole('heading', { name: '动态详情' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回列表' }));
    const bubble = screen.getByRole('button', { name: '来源评论 501' });
    expect(bubble.querySelector('svg')).not.toBeNull();
    await user.click(bubble);
    const comments = await screen.findByRole('region', { name: '评论区' });
    expect(await within(comments).findByText(/评论尚未归档/)).toBeVisible();
  });
  it('归档标题独立安全展示，不冒充正文或执行标签', async () => {
    show(async () => Response.json({ ...archive, title: '虚构标题 <img src=x onerror=alert(1)>' }), `/dynamics/${archive.id}`);
    expect(await screen.findByText('虚构标题 <img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
  it.each([
    ['空正文', { text: '', media_sources: [], edit_status: 'unknown', edited_at: null, source_comment_count: null }, '编辑信号未知。', true],
    ['仅来源图', { text: '' }, '图片待归档（1 张）。', false],
    ['受限', { text: '', media_sources: [], content_state: 'restricted', last_attempt: 'restricted' }, '正文访问受限。', false],
    ['失败', { text: '', media_sources: [], content_state: 'failed', edit_status: 'error' }, '正文尚未成功归档。', false],
  ] as const)('%s 的内容状态与无内容提示不混淆', async (_name, fields, message, empty) => {
    show(async () => Response.json({ ...archive, ...fields, published_at: null,
      author: { id: '123', nickname: null, avatar_url: null } }), `/dynamics/${archive.id}`);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByText('时间未知')).toBeInTheDocument();
    expect(screen.getByText('未知用户')).toBeInTheDocument();
    expect(screen.queryByText('暂无内容') !== null).toBe(empty);
    expect(screen.queryByText(/已保存内容仍可阅读/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/default-avatar.svg');
  });
  it.each(['unknown', 'error'] as const)('编辑信号%s仍展示旧可信分钟时间和可读正文，重新访问可读实际提交的新正文', async editStatus => {
    const urls: string[] = [];
    let document = { ...archive, edit_status: editStatus, work: { ...archive.work, text: 'success' } };
    const transport: ArchiveTransport = async (url, init) => {
      urls.push(url);
      expect(init.method).toBe('GET');
      return Response.json(url.includes('/comments?') ? { items: [], next_cursor: null } : document);
    };
    const previous = show(transport, `/dynamics/${archive.id}`);
    expect(await screen.findByText(archive.text.replace(/\s+/g, ' '))).toBeInTheDocument();
    expect(screen.getByText('编辑于 2026-03-02 13:01')).toBeInTheDocument();
    expect(screen.queryByText(/13:01:00/)).not.toBeInTheDocument();
    expect(screen.getByText(editStatus === 'unknown' ? '编辑信号未知。' : '编辑信号读取或解析失败；保留已有可信时间。')).toBeInTheDocument();
    previous.unmount();
    document = { ...document, text: '实际提交的新版正文', last_attempt: 'success',
      synced_version: 'v2', work: { ...document.work, media: 'pending' } };
    show(transport, `/dynamics/${archive.id}`);
    expect(await screen.findByText('实际提交的新版正文')).toBeInTheDocument();
    expect(screen.getByText('正文已保存；媒体待归档；评论待归档。')).toBeInTheDocument();
    expect(screen.queryByText(archive.text.replace(/\s+/g, ' '))).not.toBeInTheDocument();
    expect(urls.every(url => url.startsWith('/api/archive/'))).toBe(true);
  });
  it('正文、媒体、评论工作状态逐项呈现，不把接口状态写死为 pending', async () => {
    const completed = { ...archive, work: { text: 'success', media: 'success', comments: 'failed' } };
    show(async () => Response.json(completed), `/dynamics/${archive.id}`);
    expect(await screen.findByText('正文已保存；媒体已归档；评论读取失败。')).toBeInTheDocument();
  });
  it('详情 404 与网络失败、列表成功空分别呈现；失败内容不泄漏', async () => {
    let view = show(async () => new Response('SECRET_TOKEN', { status: 404 }), `/dynamics/${archive.id}`);
    expect(await screen.findByText('动态不存在或不可用')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    view.unmount();
    view = show(async () => { throw new Error('SECRET_TOKEN'); }, `/dynamics/${archive.id}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('动态详情读取失败');
    expect(screen.queryByText('动态不存在或不可用')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
    view.unmount();
    show(async () => Response.json({ items: [], next_cursor: null }));
    expect(await screen.findByText('暂无动态')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('生产分页 10/10/5 按服务器顺序追加，失败重试原 cursor、连点不重复且返回保留多批', async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 25 }, (_, i) => ({ ...archive, id: String(100 + i), text: `归档第 ${i + 1} 条`,
      published_at: `2026-03-${String(31 - i).padStart(2, '0')}T10:03:04+08:00` }));
    let appends = 0;
    const queries: string[] = [];
    show(async url => {
      if (url.endsWith('/ups')) return Response.json({ ups: [] });
      if (!url.includes('?')) return Response.json(items[24]);
      queries.push(url);
      if (url.includes('cursor=page2') && ++appends === 1) throw new Error('SECRET_TOKEN');
      const offset = url.includes('cursor=page2') ? 10 : url.includes('cursor=page3') ? 20 : 0;
      return Response.json({ items: items.slice(offset, offset + 10), next_cursor: offset === 0 ? 'page2' : offset === 10 ? 'page3' : null });
    });
    await screen.findByText('归档第 10 条');
    expect(screen.getAllByRole('article')).toHaveLength(10);
    await user.dblClick(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('动态追加读取失败');
    expect(screen.getAllByRole('article')).toHaveLength(10);
    await user.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('归档第 20 条');
    expect(screen.getAllByRole('article')).toHaveLength(20);
    await user.click(screen.getByRole('button', { name: '加载更多' }));
    await screen.findByText('归档第 25 条');
    expect(screen.getAllByRole('article')).toHaveLength(25);
    expect(screen.getByText('动态已加载完毕')).toBeInTheDocument();
    expect(queries).toEqual(['/api/archive/dynamics?limit=10&scope=all', '/api/archive/dynamics?limit=10&scope=all&cursor=page2',
      '/api/archive/dynamics?limit=10&scope=all&cursor=page2', '/api/archive/dynamics?limit=10&scope=all&cursor=page3']);
    await user.click(within(screen.getAllByRole('article')[24]!).getByRole('link', { name: '阅读全文 124' }));
    await screen.findByRole('heading', { name: '动态详情' });
    await user.click(screen.getByRole('button', { name: '返回列表' }));
    expect(screen.getAllByRole('article')).toHaveLength(25);
    expect(screen.getAllByRole('article').map(card => card.getAttribute('data-reading-id'))).toEqual(items.map(item => item.id));
  });
  it('旧成功正文保持可读，来源/本地计数、分钟编辑、最后失败与待媒体独立表达；评论不虚构为空', async () => {
    const user = userEvent.setup();
    const urls: string[] = [];
    show(async url => { urls.push(url); return Response.json(url.endsWith('/ups') ? { ups: [] }
      : url.includes('/comments?') ? { items: [], next_cursor: null }
      : url.includes('?') ? { items: [archive], next_cursor: null } : archive); });
    expect(await screen.findByText(archive.text.replace(/\s+/g, ' '))).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '全部动态' })).toBeInTheDocument();
    expect(screen.getByText('2026-03-01 10:03:04')).toBeInTheDocument();
    expect(screen.getByText('编辑于 2026-03-02 13:01')).toBeInTheDocument();
    expect(screen.queryByText(/13:01:00/)).not.toBeInTheDocument();
    expect(screen.getByText('最近正文读取失败；已保存内容仍可阅读。')).toBeInTheDocument();
    expect(screen.getByText('图片待归档（1 张）。')).toBeInTheDocument();
    expect(screen.getByText('本地已归档一级评论：0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '来源评论 501' })).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img[src="https://upstream.example.test/image.jpg"]')).toBeNull();
    await user.click(screen.getByRole('link', { name: `阅读全文 ${archive.id}` }));
    const comments = within(screen.getByRole('region', { name: '评论区' }));
    expect(await comments.findByText('评论尚未归档；来源计数不代表本地已有评论。')).toBeInTheDocument();
    expect(comments.queryByText('暂无评论')).not.toBeInTheDocument();
    expect(comments.getByRole('button', { name: '最新' })).toBeEnabled();
    expect(urls.every(url => url.startsWith('/api/archive/dynamics') || url === '/api/archive/ups')).toBe(true);
    await user.click(screen.getByRole('button', { name: '返回列表' }));
    expect(screen.getByRole('heading', { name: '全部动态' })).toBeInTheDocument();
  });
});

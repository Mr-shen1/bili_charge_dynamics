import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/app/App';
import { createArchiveReader, type ArchiveTransport } from '../src/data/archiveReader';
import { archive } from './fixtures/archive';
import { rootComment } from './fixtures/rootComment';

const sync = {
  id: archive.id, active: true, check_status: 'unchanged', work: 'pending', revision: 2,
  last_checked_at: '2025-06-01T02:00:00Z', last_succeeded_at: null,
  observed: { source_comment_count: 501, comment_count_status: 'observed', edit_status: 'unknown' },
  synced_version: null, check_error: null, sync_error: 'SYNC_INCOMPLETE',
  synced_comment_count: null, local_comment_count: 2, local_reply_count: 1, comments_last_attempt: 'failed',
  parts: { text: 'restricted', media: 'success', comments: 'success', replies: 'pending', comment_media: 'pending' },
};
const signal = new AbortController().signal;
function show(transport: ArchiveTransport) {
  return render(<MemoryRouter initialEntries={[`/dynamics/${archive.id}`]}><App reader={createArchiveReader(transport)} /></MemoryRouter>);
}

describe('评论同步状态生产读取', () => {
  it('详情保留最新检查状态，不把归档 HTTP 成功当作同步成功', async () => {
    const reader = createArchiveReader(async () => Response.json({ ...archive, comment_sync: sync }));
    expect(await reader.readDetail({ id: archive.id, signal })).toMatchObject({ status: 'success', data: {
      archive: { commentSync: { work: 'pending', checkStatus: 'unchanged', syncError: 'SYNC_INCOMPLETE' } },
    } });
  });
  it('来源、本地根回复和当前已加载数分开；回复失败与图片未完成不被 HTTP 成功掩盖', async () => {
    show(async url => Response.json(url.includes('/comments?')
      ? { items: [{ ...rootComment, source_reply_count: 0 }], next_cursor: null }
      : { ...archive, local_comment_count: 2, local_reply_count: 1, comment_sync: sync }));
    const area = within(await screen.findByRole('region', { name: '评论区' }));
    await area.findByText(rootComment.text!);
    expect(area.getByText('来源评论总数：501；本地一级评论：2；本地回复：1；当前已加载一级评论：1。')).toBeVisible();
    expect(area.getByText('评论部分完成，最近同步失败，待后台重试。')).toBeVisible();
    expect(area.getByText('评论图片待处理；评论文本完成不代表图片完成。')).toBeVisible();
    expect(area.getByText('本地归档评论已读完')).toBeVisible();
    expect(area.queryByText('评论已加载完毕')).not.toBeInTheDocument();
  });
  it('只读刷新状态保留已加载评论、排序和原 cursor；失败不替换旧状态或正文', async () => {
    const user = userEvent.setup();
    let details = 0;
    let refreshed = false;
    const requests: string[] = [];
    show(async (url, init) => {
      requests.push(url);
      expect(init.method).toBe('GET');
      if (url.includes('/comments?')) return Response.json({ items: [{ ...rootComment,
        id: url.includes('cursor=next') ? '302' : '301', text: url.includes('cursor=next') ? '第二批保留评论' : '首批保留评论', source_reply_count: 0 }], next_cursor: url.includes('cursor=next') ? null : 'next' });
      details++;
      if (details === 2) return new Response('SECRET_TOKEN', { status: 500 });
      refreshed = details > 2;
      return Response.json({ ...archive, text: refreshed ? '不应替换的正文' : '原正文',
        source_comment_count: refreshed ? 700 : 501, local_comment_count: 2, local_reply_count: 1,
        comment_sync: refreshed ? { ...sync, observed: { ...sync.observed, source_comment_count: 700 }, sync_error: null, comments_last_attempt: 'success', parts: { ...sync.parts, replies: 'success' } } : sync });
    });
    const area = within(await screen.findByRole('region', { name: '评论区' }));
    await area.findByText('首批保留评论');
    await user.click(area.getByRole('button', { name: '加载更多评论' }));
    await area.findByText('第二批保留评论');
    await user.click(area.getByRole('button', { name: '读取评论同步状态' }));
    expect(await area.findByRole('alert')).toHaveTextContent('评论同步状态读取失败；保留已有状态。');
    expect(area.getByText('评论部分完成，最近同步失败，待后台重试。')).toBeVisible();
    await user.click(area.getByRole('button', { name: '读取评论同步状态' }));
    expect(await area.findByText('本轮评论文本已完成；不代表拥有完整来源评论或实时更新。')).toBeVisible();
    expect(area.getByText('来源评论总数：700；本地一级评论：2；本地回复：1；当前已加载一级评论：2。')).toBeVisible();
    expect(area.getByRole('button', { name: '来源评论 700' })).toBeVisible();
    expect(area.getByRole('button', { name: '最热' })).toHaveAttribute('aria-pressed', 'true');
    expect(area.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('原正文')).toBeVisible();
    expect(screen.queryByText('不应替换的正文')).not.toBeInTheDocument();
    expect(requests.filter(url => url.includes('/comments?'))).toHaveLength(2);
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
  });
  it('分项时间与脱敏错误独立显示，未知时间不由最近检查代填', async () => {
    show(async url => Response.json(url.includes('/comments?') ? { items: [], next_cursor: null }
      : { ...archive, comment_sync: { ...sync, root_comments_last_succeeded_at: '2025-06-01T02:01:00Z',
        replies_last_succeeded_at: null, comments_last_succeeded_at: null, replies_error: 'REPLIES_FAILED',
        comments_error: 'REPLIES_FAILED' } }));
    const status = within(await screen.findByRole('complementary', { name: '评论归档状态' }));
    expect(status.getByText('根评论最近成功：2025-06-01 10:01:00')).toBeVisible();
    expect(status.getByText('回复最近成功：—')).toBeVisible();
    expect(status.getByText('评论整轮最近成功：—')).toBeVisible();
    expect(status.getByText('评论整轮：回复归档失败；保留已有归档，将在固定节拍重试。')).toBeVisible();
  });
  it('首读失败时已加载零条不冒充本地零或来源零，原位重试后更新已加载数', async () => {
    const user = userEvent.setup();
    let failure = true;
    show(async url => {
      if (url.includes('/comments?')) return failure ? new Response('SECRET_TOKEN', { status: 503 })
        : Response.json({ items: [{ ...rootComment, source_reply_count: 0 }], next_cursor: null });
      return Response.json({ ...archive, local_comment_count: 2, local_reply_count: 1, comment_sync: sync });
    });
    const area = within(await screen.findByRole('region', { name: '评论区' }));
    expect(await area.findByRole('alert')).toHaveTextContent('最热评论读取失败');
    expect(area.getByText('来源评论总数：501；本地一级评论：2；本地回复：1；当前已加载一级评论：0。')).toBeVisible();
    expect(area.queryByText('暂无评论')).not.toBeInTheDocument();
    failure = false;
    await user.click(area.getByRole('button', { name: '重试' }));
    expect(await area.findByText('来源评论总数：501；本地一级评论：2；本地回复：1；当前已加载一级评论：1。')).toBeVisible();
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
  });
  it('正文或媒体工作运行不把已完成评论显示为同步中', async () => {
    show(async url => Response.json(url.includes('/comments?') ? { items: [], next_cursor: null }
      : { ...archive, comments_last_attempt: 'success', root_comments_last_attempt: 'success',
        comment_sync: { ...sync, work: 'running', comments_last_attempt: 'success',
          parts: { ...sync.parts, text: 'pending', replies: 'success' } } }));
    const area = within(await screen.findByRole('region', { name: '评论区' }));
    expect(await area.findByText('本轮评论文本已完成；不代表拥有完整来源评论或实时更新。')).toBeVisible();
    expect(area.queryByText('评论同步中；已有归档仍可阅读。')).not.toBeInTheDocument();
  });
  it.each([null, 0])('来源 %s 不由本地数或当前加载数补齐，成功空明确只是本地结果', async source => {
    show(async url => Response.json(url.includes('/comments?') ? { items: [], next_cursor: null }
      : { ...archive, source_comment_count: source, local_comment_count: 0, local_reply_count: 0,
        comments_last_attempt: 'success', root_comments_last_attempt: 'success',
        comment_sync: { ...sync, observed: { ...sync.observed, source_comment_count: source },
          local_comment_count: 0, local_reply_count: 0, sync_error: null, comments_last_attempt: 'success',
          parts: { ...sync.parts, replies: 'success' } } }));
    const area = within(await screen.findByRole('region', { name: '评论区' }));
    expect(await area.findByText(`来源评论总数：${source ?? '—'}；本地一级评论：0；本地回复：0；当前已加载一级评论：0。`)).toBeVisible();
    expect(await area.findByText('暂无评论')).toBeVisible();
  });
  it.each(['success', 'error'] as const)('忽略取消的旧访问状态 %s 不能覆盖新的访问', async outcome => {
    const user = userEvent.setup();
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    let details = 0;
    let oldSignal: AbortSignal | null | undefined;
    const transport: ArchiveTransport = async (url, init) => {
      if (url.includes('/comments?')) return Response.json({ items: [], next_cursor: null });
      details++;
      if (details === 2) { oldSignal = init.signal; return pending; }
      return Response.json({ ...archive, source_comment_count: details > 2 ? 42 : 501,
        comment_sync: { ...sync, observed: { ...sync.observed, source_comment_count: details > 2 ? 42 : 501 } } });
    };
    const old = show(transport);
    await user.click(await screen.findByRole('button', { name: '读取评论同步状态' }));
    old.unmount();
    expect(oldSignal?.aborted).toBe(true);
    show(transport);
    await screen.findByRole('button', { name: '来源评论 42' });
    await act(async () => resolve(outcome === 'success'
      ? Response.json({ ...archive, source_comment_count: 999, comment_sync: sync })
      : new Response('SECRET_TOKEN', { status: 500 })));
    expect(screen.getByRole('button', { name: '来源评论 42' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '来源评论 999' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('非法/串目标同步状态与任意错误原文不会进入展示', async () => {
    for (const commentSync of [{ ...sync, id: '123' }, { ...sync, sync_error: 'SECRET_TOKEN' },
      { ...sync, last_checked_at: '2025-02-30T02:00:00Z' }]) {
      const result = await createArchiveReader(async () => Response.json({ ...archive, comment_sync: commentSync }))
        .readDetail({ id: archive.id, signal });
      expect(result).toEqual({ status: 'error' });
      expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
    }
  });
});

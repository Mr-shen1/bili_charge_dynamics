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
  it('评论区只以标题反映来源计数，不渲染独立同步状态面板', async () => {
    show(async url => Response.json(url.includes('/comments?')
      ? { items: [{ ...rootComment, source_reply_count: 0 }], next_cursor: null }
      : { ...archive, local_comment_count: 2, local_reply_count: 1, comment_sync: sync }));
    const area = within(await screen.findByRole('region', { name: '评论区' }));
    await area.findByText(rootComment.text!);
    // 视觉改版裁剪了独立状态面板与手动读取入口：来源总数只出现在评论区标题。
    expect(area.getByRole('button', { name: '来源评论 501' })).toBeVisible();
    expect(area.queryByRole('complementary', { name: '评论归档状态' })).not.toBeInTheDocument();
    expect(area.queryByRole('button', { name: '读取评论同步状态' })).not.toBeInTheDocument();
    // 列表读完后不再额外提示，只以缺少“加载更多评论”表达结束。
    expect(area.queryByRole('button', { name: '加载更多评论' })).not.toBeInTheDocument();
  });
  it('首读失败原位重试后更新已加载评论，不泄漏来源错误原文', async () => {
    const user = userEvent.setup();
    let failure = true;
    show(async url => {
      if (url.includes('/comments?')) return failure ? new Response('SECRET_TOKEN', { status: 503 })
        : Response.json({ items: [{ ...rootComment, source_reply_count: 0 }], next_cursor: null });
      return Response.json({ ...archive, local_comment_count: 2, local_reply_count: 1, comment_sync: sync });
    });
    const area = within(await screen.findByRole('region', { name: '评论区' }));
    expect(await area.findByRole('alert')).toHaveTextContent('最热评论读取失败');
    expect(area.getByRole('button', { name: '来源评论 501' })).toBeVisible();
    expect(area.queryByText('暂无评论')).not.toBeInTheDocument();
    failure = false;
    await user.click(area.getByRole('button', { name: '重试' }));
    expect(await area.findByText(rootComment.text!)).toBeVisible();
    expect(area.getAllByRole('listitem')).toHaveLength(1);
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
  });
  it.each([null, 0])('来源 %s 不由本地数或当前加载数补齐，成功空只是本地结果', async source => {
    show(async url => Response.json(url.includes('/comments?') ? { items: [], next_cursor: null }
      : { ...archive, source_comment_count: source, local_comment_count: 0, local_reply_count: 0,
        comments_last_attempt: 'success', root_comments_last_attempt: 'success',
        comment_sync: { ...sync, observed: { ...sync.observed, source_comment_count: source },
          local_comment_count: 0, local_reply_count: 0, sync_error: null, comments_last_attempt: 'success',
          parts: { ...sync.parts, replies: 'success' } } }));
    const area = within(await screen.findByRole('region', { name: '评论区' }));
    // 已知空来源照实显示 0，未知来源显示破折号，都不由本地数补齐。
    expect(await area.findByRole('button', { name: `来源评论 ${source ?? '—'}` })).toBeVisible();
    expect(await area.findByText('暂无评论')).toBeVisible();
  });
  it.each(['success', 'error'] as const)('忽略取消的旧访问状态 %s 不能覆盖新的访问', async outcome => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    let details = 0;
    let oldSignal: AbortSignal | null | undefined;
    const transport: ArchiveTransport = async (url, init) => {
      if (url.includes('/comments?')) return Response.json({ items: [], next_cursor: null });
      details++;
      if (details === 1) { oldSignal = init.signal; return pending; }
      return Response.json({ ...archive, source_comment_count: 42,
        comment_sync: { ...sync, observed: { ...sync.observed, source_comment_count: 42 } } });
    };
    const old = show(transport);
    await act(async () => {});
    await act(async () => { old.unmount(); });
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

import { fireEvent, getNodeText, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router';
import { expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { App } from '../src/app/App';
import { createArchiveReader, type ArchiveTransport } from '../src/data/archiveReader';
import { archive } from './fixtures/archive';
import { rootComment } from './fixtures/rootComment';

const reply = {
  id: '301', dynamic_id: archive.id, root_id: rootComment.id, parent_id: rootComment.id,
  author: archive.author, text: '已归档回复', published_at: null, like_count: 0, reply_to: null,
};

function HistoryControls() {
  const navigate = useNavigate();
  return <button onClick={() => void navigate(1)}>历史前进</button>;
}
function show(transport: ArchiveTransport, path = `/dynamics/${archive.id}`) {
  return render(<MemoryRouter initialEntries={[path]}>
    <HistoryControls /><App reader={createArchiveReader(transport)} />
  </MemoryRouter>);
}

it('生产Adapter确认成功且来源与本地25条相等时，3条预览不重复显示归档统计', async () => {
  show(async url => Response.json(url.includes('/replies?') ? {
    items: Array.from({ length: 3 }, (_, index) => ({ ...reply, id: String(301 + index), text: `预览回复 ${index}` })),
    next_cursor: 'more', source_reply_count: 25, local_reply_count: 25, replies_last_attempt: 'success',
  } : url.includes('/comments?') ? { items: [rootComment], next_cursor: null } : archive));
  const area = await screen.findByRole('region', { name: `回复区 ${rootComment.id}` });
  await within(area).findByText('预览回复 0');
  expect(within(area).getAllByRole('listitem')).toHaveLength(3);
  expect(within(area).queryByText(/来源回复：/)).not.toBeInTheDocument();
  expect(within(area).queryByText('回复归档尚未确认完成。')).not.toBeInTheDocument();
  const expand = within(area).getByRole('button', { name: '展开回复' });
  expect(expand).toHaveTextContent('共25条回复，点击查看');
  expect(expand).toHaveAttribute('aria-expanded', 'false');
});

it.each([
  [25, 20, 'success', '来源回复：25；本地已归档回复：20', null],
  [20, 25, 'success', '来源回复：20；本地已归档回复：25', null],
  [null, 25, 'success', '来源回复：—；本地已归档回复：25', null],
  [25, null, 'success', '来源回复：25；本地已归档回复：—', null],
  [null, null, 'success', '来源回复：—；本地已归档回复：—', null],
  [undefined, undefined, 'success', '来源回复：—；本地已归档回复：—', null],
  [undefined, 25, 'success', '来源回复：—；本地已归档回复：25', null],
  [25, undefined, 'success', '来源回复：25；本地已归档回复：—', null],
  [0, 25, 'success', '来源回复：0；本地已归档回复：25', null],
  [25, 25, 'failed', '来源回复：25；本地已归档回复：25', '回复最近归档失败；已保存回复仍可阅读。'],
  [25, 25, 'pending', '来源回复：25；本地已归档回复：25', '回复尚未完成归档。'],
  [25, 25, 'unconfirmed', '来源回复：25；本地已归档回复：25', '回复归档尚未确认完成。'],
  [25, 25, undefined, '来源回复：25；本地已归档回复：25', '回复归档尚未确认完成。'],
] as const)('生产Adapter来源%s/本地%s/%s保留统计与独立状态，展开入口只用来源总数', async (source, local, attempt, counts, notice) => {
  show(async url => Response.json(url.includes('/replies?') ? {
    items: [reply], next_cursor: 'more', source_reply_count: source, local_reply_count: local,
    replies_last_attempt: attempt,
  } : url.includes('/comments?') ? { items: [rootComment], next_cursor: null } : archive));
  const area = await screen.findByRole('region', { name: `回复区 ${rootComment.id}` });
  await within(area).findByText('已归档回复');
  expect(within(area).getByText(counts)).toBeVisible();
  const expand = within(area).getByRole('button', { name: '展开回复' });
  expect(expand).toHaveTextContent(source == null ? '展开回复' : `共${source}条回复，点击查看`);
  expect(expand).toHaveAttribute('aria-label', '展开回复');
  expect(expand).toHaveAttribute('aria-expanded', 'false');
  expect(expand).toHaveAttribute('aria-controls', within(area).getByRole('list', { name: '回复列表' }).id);
  if (notice) expect(within(area).getByRole('status')).toHaveTextContent(notice);
  else expect(within(area).queryByRole('status')).not.toBeInTheDocument();
  expect(within(area).queryByText('回复已加载完毕')).not.toBeInTheDocument();
});

it('生产Adapter成功的已知零计数相等可省略统计，但空回复提示仍保留', async () => {
  show(async url => Response.json(url.includes('/replies?') ? {
    items: [], next_cursor: null, source_reply_count: 0, local_reply_count: 0, replies_last_attempt: 'success',
  } : url.includes('/comments?') ? { items: [rootComment], next_cursor: null } : archive));
  const area = await screen.findByRole('region', { name: `回复区 ${rootComment.id}` });
  expect(await within(area).findByText('暂无回复')).toBeVisible();
  expect(within(area).queryByText(/来源回复：/)).not.toBeInTheDocument();
  expect(within(area).queryByRole('button', { name: '展开回复' })).not.toBeInTheDocument();
});

it.each([
  ['failed', '回复最近归档失败；已保存回复仍可阅读。'],
  ['pending', '回复尚未完成归档。'],
  ['unconfirmed', '回复归档尚未确认完成。'],
  [undefined, '回复归档尚未确认完成。'],
] as const)('回复HTTP成功空批仍保留逐根%s状态，未知来源与本地零分开，不冒充暂无回复', async (attempt, message) => {
  show(async url => Response.json(url.includes('/replies?') ? {
    items: [], next_cursor: null, source_reply_count: null, local_reply_count: 0,
    replies_last_attempt: attempt, synced_source_reply_count: null,
  } : url.includes('/comments?') ? { items: [{ ...rootComment, source_reply_count: null }], next_cursor: null } : archive));
  const area = await screen.findByRole('region', { name: `回复区 ${rootComment.id}` });
  expect(await within(area).findByText(message)).toBeVisible();
  expect(within(area).getByText('来源回复：—；本地已归档回复：0')).toBeVisible();
  expect(within(area).queryByText('暂无回复')).not.toBeInTheDocument();
  expect(within(area).queryByText('回复已加载完毕')).not.toBeInTheDocument();
  expect(within(area).queryByRole('button', { name: /重试|展开回复/ })).not.toBeInTheDocument();
});

it('确认归档成功的空回复才显示暂无回复，零来源根不请求回复', async () => {
  const requests: string[] = [];
  show(async url => {
    if (url.includes('/replies?')) requests.push(url);
    return Response.json(url.includes('/replies?') ? { items: [], next_cursor: null, source_reply_count: null,
      local_reply_count: 0, replies_last_attempt: 'success' }
      : url.includes('/comments?') ? { items: [{ ...rootComment, source_reply_count: null },
        { ...rootComment, id: '222', source_reply_count: 0 }], next_cursor: null } : archive);
  });
  const area = await screen.findByRole('region', { name: `回复区 ${rootComment.id}` });
  expect(await within(area).findByText('暂无回复')).toBeVisible();
  expect(within(area).getByText('来源回复：—；本地已归档回复：0')).toBeVisible();
  expect(screen.queryByRole('region', { name: '回复区 222' })).not.toBeInTheDocument();
  expect(requests).toEqual([`/api/archive/dynamics/${archive.id}/comments/${rootComment.id}/replies?limit=3`]);
});

it('生产Adapter按时间整页10/10/5读取，失败原页重试，历史保留预览元数据但展开重读', async () => {
  const user = userEvent.setup();
  const target = { id: '456', nickname: '上一页的回复者', avatar_url: null };
  const items = Array.from({ length: 25 }, (_, index) => ({ ...reply, id: String(300 + index),
    published_at: new Date(Date.UTC(2026, 2, 1, 0, index)).toISOString(),
    text: `服务端回复 ${index}`, like_count: 25 - index,
    ...(index === 10 || index === 20 ? { parent_id: String(299 + index), reply_to: target } : {}),
  }));
  const requests: string[] = [];
  let failed = false;
  show(async (url, init) => {
    if (url.endsWith('/ups')) return Response.json({ ups: [] });
    if (url.includes('/replies?')) {
      requests.push(url);
      expect(init?.method).toBe('GET');
      const query = new URL(url, 'https://archive.example.test').searchParams;
      const page = query.get('page');
      if (page !== null) {
        expect(query.get('limit')).toBe('10');
        expect(query.has('cursor')).toBe(false);
        expect(init?.cache).toBe('no-store');
        if (!failed) { failed = true; throw new Error('SECRET_TOKEN'); }
        const offset = (Number(page) - 1) * 10;
        return Response.json({ items: items.slice(offset, offset + 10), next_cursor: null,
          count: items.length, root: rootComment, local_reply_count: items.length,
          source_reply_count: page === '3' ? null : 30,
          replies_last_attempt: page === '3' ? 'success' : 'failed', synced_source_reply_count: null });
      }
      expect(query.get('limit')).toBe('3');
      expect(query.has('cursor')).toBe(false);
      return Response.json({ items: items.slice(0, 3), next_cursor: 'second+/=',
        source_reply_count: 30, local_reply_count: 25, replies_last_attempt: 'failed', synced_source_reply_count: null });
    }
    return Response.json(url.includes('/comments?') ? { items: [rootComment], next_cursor: null }
      : url.includes('?') ? { items: [archive], next_cursor: null } : archive);
  }, '/');
  await user.click(await screen.findByRole('link', { name: `阅读全文 ${archive.id}` }));
  let area = await screen.findByRole('region', { name: `回复区 ${rootComment.id}` });
  await within(area).findByText('服务端回复 0');
  expect(within(area).getAllByRole('listitem')).toHaveLength(3);
  const expand = within(area).getByRole('button', { name: '展开回复' });
  fireEvent.click(expand);
  fireEvent.click(expand);
  expect(await within(area).findByRole('alert')).toHaveTextContent('回复追加读取失败');
  expect(within(area).getAllByRole('listitem')).toHaveLength(3);
  expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
  await user.click(within(area).getByRole('button', { name: '重试' }));
  await within(area).findByText('服务端回复 9');
  expect(within(area).getAllByRole('listitem')).toHaveLength(10);
  await user.click(within(area).getByRole('button', { name: '收起' }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(3);
  await user.click(screen.getByRole('button', { name: '返回列表' }));
  await screen.findByRole('link', { name: `阅读全文 ${archive.id}` });
  await user.click(screen.getByRole('button', { name: '历史前进' }));
  area = await screen.findByRole('region', { name: `回复区 ${rootComment.id}` });
  expect(within(area).getByText('来源回复：30；本地已归档回复：25')).toBeVisible();
  expect(within(area).getByText('回复最近归档失败；已保存回复仍可阅读。')).toBeVisible();
  expect(within(area).getAllByRole('listitem')).toHaveLength(3);
  expect(requests).toHaveLength(3);
  items[0]!.text = '服务端回复 0（重读）';
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  await within(area).findByText('服务端回复 0（重读）');
  expect(within(area).getAllByRole('listitem')).toHaveLength(10);
  expect(requests).toHaveLength(4);
  await user.click(within(area).getByRole('button', { name: '下一页' }));
  await within(area).findByText('服务端回复 19');
  expect(within(area).getAllByRole('listitem')).toHaveLength(10);
  expect(within(area).queryByText('服务端回复 0（重读）')).not.toBeInTheDocument();
  expect(within(area).getByText('回复 上一页的回复者:')).toBeVisible();
  expect(within(area).getAllByRole('listitem').map(row => getNodeText(within(row).getByText(/^服务端回复/)).trim()))
    .toEqual(Array.from({ length: 10 }, (_, index) => `服务端回复 ${10 + index}`));
  await user.click(within(area).getByRole('button', { name: '下一页' }));
  await within(area).findByText('服务端回复 24');
  expect(within(area).getAllByRole('listitem')).toHaveLength(5);
  expect(within(area).getByText('来源回复：—；本地已归档回复：25')).toBeVisible();
  expect(within(area).queryByText('回复最近归档失败；已保存回复仍可阅读。')).not.toBeInTheDocument();
  expect(within(area).getByRole('button', { name: '下一页' })).toBeDisabled();
  expect(within(area).getByText('回复 上一页的回复者:')).toBeVisible();
  expect(within(area).getAllByRole('listitem').map(row => getNodeText(within(row).getByText(/^服务端回复/)).trim())).toEqual([
    '服务端回复 20', '服务端回复 21', '服务端回复 22', '服务端回复 23', '服务端回复 24',
  ]);
  expect(within(area).queryByText('回复已加载完毕')).not.toBeInTheDocument();
  await user.click(within(area).getByRole('button', { name: '收起' }));
  expect(within(area).getByText('服务端回复 0')).toBeVisible();
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  await within(area).findByText('服务端回复 0（重读）');
  await waitFor(() => expect(within(area).getByRole('button', { name: '下一页' })).toBeEnabled());
  expect(within(area).getAllByRole('listitem')).toHaveLength(10);
  const base = `/api/archive/dynamics/${archive.id}/comments/${rootComment.id}/replies`;
  expect(requests).toEqual([`${base}?limit=3`, `${base}?page=1&limit=10`, `${base}?page=1&limit=10`,
    `${base}?page=1&limit=10`, `${base}?page=2&limit=10`, `${base}?page=3&limit=10`, `${base}?page=1&limit=10`]);
});

it('部分归档回复仍可读完本地批次，但分页结束不冒充来源归档完成', async () => {
  show(async url => Response.json(url.includes('/replies?') ? {
    items: [reply], next_cursor: null, source_reply_count: 25, local_reply_count: 1,
    replies_last_attempt: 'failed', synced_source_reply_count: null,
  } : url.includes('/comments?') ? { items: [rootComment], next_cursor: null } : archive));
  const area = await screen.findByRole('region', { name: `回复区 ${rootComment.id}` });
  expect(await within(area).findByText('已归档回复')).toBeVisible();
  expect(within(area).getByText('来源回复：25；本地已归档回复：1')).toBeVisible();
  expect(within(area).queryByText('本地归档回复已读完')).not.toBeInTheDocument();
  expect(within(area).queryByRole('navigation', { name: '回复分页' })).not.toBeInTheDocument();
  expect(within(area).getByText('回复最近归档失败；已保存回复仍可阅读。')).toBeVisible();
  expect(within(area).queryByText('回复已加载完毕')).not.toBeInTheDocument();
  expect(within(area).queryByRole('button', { name: /加载更多回复|重试/ })).not.toBeInTheDocument();
});

it('兼容CURSOR_INVALID响应仅显式重启对应根，保留其他根内容且UI不发送旧cursor', async () => {
  const user = userEvent.setup();
  const urls: string[] = [];
  const otherId = '222';
  show(async url => {
    if (url.includes('/replies?')) {
      urls.push(url);
      if (new URL(url, 'https://archive.example.test').searchParams.has('page')) return Response.json({ error: { code: 'CURSOR_INVALID', message: 'SECRET_TOKEN' } }, { status: 422 });
      if (url.includes(`/comments/${otherId}/`)) return Response.json({ items: [{ ...reply, id: '302', root_id: otherId,
        parent_id: otherId, text: '其他根的回复' }], next_cursor: null });
      return Response.json({ items: [reply], next_cursor: 'expired+/=', source_reply_count: 25,
        local_reply_count: 25, replies_last_attempt: 'success' });
    }
    return Response.json(url.includes('/comments?') ? { items: [rootComment, { ...rootComment, id: otherId }], next_cursor: null } : archive);
  });
  const area = await screen.findByRole('region', { name: `回复区 ${rootComment.id}` });
  const other = await screen.findByRole('region', { name: `回复区 ${otherId}` });
  await within(area).findByText('已归档回复');
  await within(other).findByText('其他根的回复');
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  expect(await within(area).findByRole('alert')).toHaveTextContent('回复读取标记无效，请重新开始读取。');
  expect(within(area).getByText('已归档回复')).toBeVisible();
  expect(within(area).queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  await user.click(within(area).getByRole('button', { name: '重新开始读取' }));
  await within(area).findByText('已归档回复');
  expect(within(area).getByRole('button', { name: '展开回复' })).toBeVisible();
  expect(within(area).queryByRole('button', { name: '收起回复' })).not.toBeInTheDocument();
  expect(within(other).getByText('其他根的回复')).toBeVisible();
  const base = `/api/archive/dynamics/${archive.id}/comments`;
  expect(urls).toEqual([`${base}/${rootComment.id}/replies?limit=3`, `${base}/${otherId}/replies?limit=3`,
    `${base}/${rootComment.id}/replies?page=1&limit=10`, `${base}/${rootComment.id}/replies?limit=3`]);
  expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
});

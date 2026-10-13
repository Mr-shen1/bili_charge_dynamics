import { fireEvent, render, screen, within } from '@testing-library/react';
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
  expect(screen.queryByRole('region', { name: '回复区 222' })).not.toBeInTheDocument();
  expect(requests).toEqual([`/api/archive/dynamics/${archive.id}/comments/${rootComment.id}/replies?limit=3`]);
});

it('生产Adapter保留服务端25条顺序及3/13/23/25范围，失败同批重试，历史保存元数据和cursor', async () => {
  const user = userEvent.setup();
  const items = Array.from({ length: 25 }, (_, index) => ({ ...reply, id: String(300 + index),
    text: `服务端回复 ${index}`, like_count: 25 - index }));
  const requests: string[] = [];
  let failed = false;
  show(async url => {
    if (url.endsWith('/ups')) return Response.json({ ups: [] });
    if (url.includes('/replies?')) {
      requests.push(url);
      const cursor = new URL(url, 'https://archive.example.test').searchParams.get('cursor');
      if (cursor === 'second+/=' && !failed) { failed = true; throw new Error('SECRET_TOKEN'); }
      const offset = cursor === 'second+/=' ? 3 : cursor === 'third' ? 13 : cursor === 'last' ? 23 : 0;
      return Response.json({ items: items.slice(offset, offset === 0 ? 3 : offset + 10),
        next_cursor: offset === 0 ? 'second+/=' : offset === 3 ? 'third' : offset === 13 ? 'last' : null,
        // 旧冻结/可选DTO字段可能只在首批出现，追加不得丢掉已知归档状态。
        ...(offset === 0 ? { source_reply_count: 30, local_reply_count: 25,
          replies_last_attempt: 'failed', synced_source_reply_count: null }
          : offset === 23 ? { source_reply_count: null, local_reply_count: 25,
            replies_last_attempt: 'success', synced_source_reply_count: null } : {}) });
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
  await within(area).findByText('服务端回复 12');
  expect(within(area).getAllByRole('listitem')).toHaveLength(13);
  await user.click(within(area).getByRole('button', { name: '收起回复' }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(3);
  await user.click(screen.getByRole('button', { name: '返回列表' }));
  await screen.findByRole('link', { name: `阅读全文 ${archive.id}` });
  await user.click(screen.getByRole('button', { name: '历史前进' }));
  area = await screen.findByRole('region', { name: `回复区 ${rootComment.id}` });
  expect(within(area).getByText('来源回复：30；本地已归档回复：25')).toBeVisible();
  expect(within(area).getByText('回复最近归档失败；已保存回复仍可阅读。')).toBeVisible();
  expect(within(area).getAllByRole('listitem')).toHaveLength(3);
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(13);
  expect(requests).toHaveLength(3);
  await user.click(within(area).getByRole('button', { name: '加载更多回复' }));
  await within(area).findByText('服务端回复 22');
  expect(within(area).getAllByRole('listitem')).toHaveLength(23);
  await user.click(within(area).getByRole('button', { name: '加载更多回复' }));
  await within(area).findByText('服务端回复 24');
  expect(within(area).getAllByRole('listitem')).toHaveLength(25);
  expect(within(area).getByText('来源回复：—；本地已归档回复：25')).toBeVisible();
  expect(within(area).queryByText('回复最近归档失败；已保存回复仍可阅读。')).not.toBeInTheDocument();
  expect(within(area).getByText('回复已加载完毕')).toBeVisible();
  expect(within(area).getAllByRole('listitem').map(row => within(row).getByText(/^服务端回复/).textContent)).toEqual([
    '服务端回复 0', '服务端回复 1', '服务端回复 2', '服务端回复 3', '服务端回复 4',
    '服务端回复 5', '服务端回复 6', '服务端回复 7', '服务端回复 8', '服务端回复 9',
    '服务端回复 10', '服务端回复 11', '服务端回复 12', '服务端回复 13', '服务端回复 14',
    '服务端回复 15', '服务端回复 16', '服务端回复 17', '服务端回复 18', '服务端回复 19',
    '服务端回复 20', '服务端回复 21', '服务端回复 22', '服务端回复 23', '服务端回复 24',
  ]);
  expect(within(area).queryByRole('button', { name: '加载更多回复' })).not.toBeInTheDocument();
  await user.click(within(area).getByRole('button', { name: '收起回复' }));
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(25);
  const base = `/api/archive/dynamics/${archive.id}/comments/${rootComment.id}/replies`;
  expect(requests).toEqual([`${base}?limit=3`, `${base}?limit=10&cursor=second%2B%2F%3D`,
    `${base}?limit=10&cursor=second%2B%2F%3D`, `${base}?limit=10&cursor=third`, `${base}?limit=10&cursor=last`]);
});

it('部分归档回复仍可读完本地批次，但分页结束不冒充来源归档完成', async () => {
  show(async url => Response.json(url.includes('/replies?') ? {
    items: [reply], next_cursor: null, source_reply_count: 25, local_reply_count: 1,
    replies_last_attempt: 'failed', synced_source_reply_count: null,
  } : url.includes('/comments?') ? { items: [rootComment], next_cursor: null } : archive));
  const area = await screen.findByRole('region', { name: `回复区 ${rootComment.id}` });
  expect(await within(area).findByText('已归档回复')).toBeVisible();
  expect(within(area).getByText('来源回复：25；本地已归档回复：1')).toBeVisible();
  expect(within(area).getByText('本地归档回复已读完')).toBeVisible();
  expect(within(area).getByText('回复最近归档失败；已保存回复仍可阅读。')).toBeVisible();
  expect(within(area).queryByText('回复已加载完毕')).not.toBeInTheDocument();
  expect(within(area).queryByRole('button', { name: /加载更多回复|重试/ })).not.toBeInTheDocument();
});

it('回复cursor失效仅显式重启对应根，保留其他根内容，不再次发送失效标记', async () => {
  const user = userEvent.setup();
  const urls: string[] = [];
  const otherId = '222';
  show(async url => {
    if (url.includes('/replies?')) {
      urls.push(url);
      if (url.includes('cursor=')) return Response.json({ error: { code: 'CURSOR_INVALID', message: 'SECRET_TOKEN' } }, { status: 422 });
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
    `${base}/${rootComment.id}/replies?limit=10&cursor=expired%2B%2F%3D`, `${base}/${rootComment.id}/replies?limit=3`]);
  expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
});

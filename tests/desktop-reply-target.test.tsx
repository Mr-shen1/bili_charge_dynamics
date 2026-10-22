import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it } from 'vitest';
import { App } from '../src/app/App';
import type { Reply } from '../src/data/contracts';
import { createMockReader } from '../src/data/mockReader';

const creator = { id: 'up', nickname: '根评论作者', avatarUrl: null };
const author = { id: 'reader', nickname: '回复作者', avatarUrl: null };
const target = { id: 'parent-author', nickname: '父回复作者', avatarUrl: null };
const direct: Reply = {
  id: 'direct', author, parentId: null, publishedAt: null,
  text: '直接回复根评论', likeCount: 0, replyTo: creator,
};

function show(replies: readonly Reply[]) {
  const reader = createMockReader({
    creator,
    dynamics: [{ id: 'd', author: creator, publishedAt: null, text: '动态正文', commentCount: 1 }],
    comments: { d: [{ id: 'root', author: creator, publishedAt: null, text: '根评论正文',
      likeCount: 0, replyCount: replies.length }] },
    replies: { d: { root: replies } },
  });
  return render(<MemoryRouter initialEntries={['/dynamics/d']}><App reader={reader} /></MemoryRouter>);
}

it('桌面楼中楼展示实际回复对象，直接回根及父评论缺失不伪造目标', async () => {
  show([
    direct,
    { ...direct, id: 'nested', parentId: 'parent-reply', replyTo: target,
      text: '回复 @父回复作者: 嵌套回复正文' },
    { ...direct, id: 'orphan', parentId: 'missing-parent', replyTo: null, text: '父评论缺失正文' },
  ]);
  const area = await screen.findByRole('region', { name: '回复区 root' });
  const nestedText = await within(area).findByText(/嵌套回复正文/);
  const nested = nestedText.closest('li')!;
  expect(within(nested).getByText('回复 父回复作者:')).toBeVisible();
  expect(within(nested).queryByText('回复 @父回复作者: 嵌套回复正文')).not.toBeInTheDocument();
  const rootReply = within(area).getByText(/直接回复根评论/).closest('li')!;
  expect(within(rootReply).queryByText('回复 根评论作者:')).not.toBeInTheDocument();
  const orphan = within(area).getByText(/父评论缺失正文/).closest('li')!;
  expect(within(orphan).queryByText(/^回复 .*:/)).not.toBeInTheDocument();
});

it('桌面楼中楼翻页后仍显示跨页父回复的对象', async () => {
  const user = userEvent.setup();
  const replies = Array.from({ length: 12 }, (_, index): Reply => ({
    ...direct, id: `reply-${String(index).padStart(2, '0')}`, text: `回复正文 ${index}`,
  }));
  replies[10] = { ...direct, id: 'reply-10', parentId: 'reply-00', replyTo: target,
    text: '第二页嵌套正文' };
  show(replies);
  const area = await screen.findByRole('region', { name: '回复区 root' });
  await within(area).findByText('回复正文 0');
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  await user.click(within(area).getByRole('button', { name: '下一页' }));
  const nested = (await within(area).findByText(/第二页嵌套正文/)).closest('li')!;
  expect(within(nested).getByText('回复 父回复作者:')).toBeVisible();
  expect(within(area).queryByText('回复正文 0')).not.toBeInTheDocument();
});

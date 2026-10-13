import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/app/App';
import { createArchiveReader } from '../src/data/archiveReader';
import { archive } from './fixtures/archive';

function media(owner: { type: 'dynamic' | 'comment'; id: string }, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${owner.type}-${owner.id}-${index}`, owner, position: index, status: 'success',
    public_url: `https://oss.example.test/${owner.type}/${owner.id}/${index}.jpg`, width: 600, height: 1600,
  }));
}
function root(id: string, count: number, text = '') {
  return { id, dynamic_id: archive.id, root_id: '0', parent_id: '0', author: archive.author,
    published_at: archive.published_at, text, like_count: 0, source_reply_count: 0, comment_locator: null,
    media_sources: [], media: media({ type: 'comment', id }, count) };
}
function show(comments = [root('101', 4), root('102', 1), root('103', 0, '纯文字'), root('104', 0)]) {
  const requests: string[] = [];
  const reader = createArchiveReader(async path => {
    requests.push(path);
    if (path.includes('/comments?')) return Response.json({ items: comments, next_cursor: null });
    if (path.endsWith(archive.id)) return Response.json({ ...archive, media: media({ type: 'dynamic', id: archive.id }, 2) });
    return Response.json({ ups: [] });
  });
  render(<MemoryRouter initialEntries={[`/dynamics/${archive.id}`]}><App reader={reader} /></MemoryRouter>);
  return requests;
}

describe('生产评论图片阅读', () => {
  it('上传失败不假装浏览器可重试，浏览器坏图只重试原地址；未完成纯图不显示空正文', async () => {
    const user = userEvent.setup();
    const comment = root('101', 4);
    const requests = show([{ ...comment, media: comment.media.map((image, index) => ({ ...image,
      status: index === 0 ? 'pending' : index === 1 ? 'failed' : 'success',
    })) }]);
    const comments = await screen.findByRole('list', { name: '一级评论' });
    await within(comments).findByText('图片待归档');
    expect(within(comments).getByText('图片归档失败')).toBeVisible();
    expect(within(comments).queryByText('暂无评论内容')).not.toBeInTheDocument();
    expect(within(comments).queryByRole('button', { name: '重试图片 2' })).not.toBeInTheDocument();
    await user.click(within(comments).getByRole('button', { name: '预览图片 2' }));
    const preview = await screen.findByRole('dialog');
    expect(within(preview).getByText('图片归档失败')).toBeVisible();
    expect(within(preview).queryByRole('img')).not.toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    fireEvent.error(within(preview).getByRole('img'));
    expect(within(preview).getByText('图片加载失败')).toBeVisible();
    await user.click(within(preview).getByRole('button', { name: '重试预览图片 3' }));
    expect(within(preview).getByRole('img')).toHaveAttribute('src', 'https://oss.example.test/comment/101/2.jpg');
    await user.keyboard('{ArrowRight}{Escape}');
    expect(requests.every(path => !path.includes('/sync'))).toBe(true);
  });
  it('纯图不补空正文、纯文字无图区，只有两者皆空才兜底；所点图片只在当前评论组切换', async () => {
    const user = userEvent.setup();
    show();
    const comments = await screen.findByRole('list', { name: '一级评论' });
    const rows = await within(comments).findAllByRole('listitem');
    if (!rows[0] || !rows[1] || !rows[2] || !rows[3]) throw new Error('Expected four root comments');
    expect(within(rows[0]).queryByText('暂无评论内容')).not.toBeInTheDocument();
    expect(within(rows[0]).getByRole('group', { name: '评论图片' })).toBeVisible();
    expect(within(rows[2]).getByText('纯文字')).toBeVisible();
    expect(within(rows[2]).queryByRole('group', { name: '评论图片' })).not.toBeInTheDocument();
    expect(within(rows[3]).getByText('暂无评论内容')).toBeVisible();
    const trigger = within(rows[0]).getByRole('button', { name: '预览图片 3' });
    await user.click(trigger);
    const preview = await screen.findByRole('dialog', { name: '图片预览' });
    expect(within(preview).getByText('3 / 4')).toBeVisible();
    expect(within(preview).getByRole('img')).toHaveAttribute('src', 'https://oss.example.test/comment/101/2.jpg');
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(within(preview).getByText('4 / 4')).toBeVisible();
    expect(within(preview).getByRole('button', { name: '下一张' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    await user.click(within(rows[1]).getByRole('button', { name: '预览图片 1' }));
    const single = await screen.findByRole('dialog');
    expect(within(single).getByText('1 / 1')).toBeVisible();
    expect(within(single).queryByRole('button', { name: '下一张' })).not.toBeInTheDocument();
    expect(within(single).getByRole('img')).toHaveAttribute('src', 'https://oss.example.test/comment/102/0.jpg');
    await user.keyboard('{Escape}');
  });
});

import { expect, it } from 'vitest';
import { createMockReader } from '../src/data/mockReader';
import { reader as normalReader } from '../src/data/assembly';

const creator = { id: 'up', nickname: '纸飞机', avatarUrl: null };
const dynamic = { id: 'd', author: creator, publishedAt: null, text: '', commentCount: 26 };
const comment = { id: 'root', author: creator, publishedAt: null, text: '一级评论', likeCount: 0, replyCount: 25 };
const replies = Array.from({ length: 25 }, (_, i) => ({
  id: `reply-${String(i).padStart(2, '0')}`, author: creator,
  publishedAt: '2026-01-01T00:00:00Z', text: `回复 ${i}`, likeCount: 0, replyTo: null,
})).reverse();

it('正常样例完整计数含45条一级评论及25条回复，不随读取范围变动', async () => {
  const signal = new AbortController().signal;
  const detail = await normalReader.readDetail({ id: '90071992547409931', signal });
  const comments = await normalReader.readComments({ dynamicId: '90071992547409931', sort: 'hot', signal });
  if (detail.status !== 'success' || comments.status !== 'success') throw new Error('Expected success');
  expect(detail.data.commentCount).toBe(70);
  expect(comments.data.items[0]?.replyCount).toBe(25);
  const preview = await normalReader.readReplies({ dynamicId: detail.data.id, rootId: 'comment-44', limit: 3, signal });
  if (preview.status !== 'success') throw new Error('Expected success');
  expect(preview.data.items).toHaveLength(3);
  const allComments = [...comments.data.items];
  let commentCursor = comments.data.nextCursor;
  while (commentCursor) {
    const next = await normalReader.readComments({ dynamicId: detail.data.id, sort: 'hot', cursor: commentCursor, signal });
    if (next.status !== 'success') throw new Error('Expected success');
    allComments.push(...next.data.items);
    commentCursor = next.data.nextCursor;
  }
  let actualReplyTotal = 0;
  for (const root of allComments) {
    let cursor: string | null = null;
    let actualRootTotal = 0;
    do {
      const result = await normalReader.readReplies({ dynamicId: detail.data.id, rootId: root.id, limit: cursor === null ? 3 : 10, cursor, signal });
      if (result.status !== 'success') throw new Error('Expected success');
      actualRootTotal += result.data.items.length;
      cursor = result.data.nextCursor;
    } while (cursor);
    expect(root.replyCount).toBe(actualRootTotal);
    actualReplyTotal += actualRootTotal;
  }
  expect(allComments).toHaveLength(45);
  expect(actualReplyTotal).toBe(25);
  expect(allComments.length + actualReplyTotal).toBe(detail.data.commentCount);
  expect(await normalReader.readDetail({ id: detail.data.id, signal })).toEqual(detail);
  expect(await normalReader.readComments({ dynamicId: detail.data.id, sort: 'hot', signal })).toEqual(comments);
});

it('回复不使用点赞排序，明确时区的时刻正序，空值置后并规范化身份目标及计数', async () => {
  const reader = createMockReader({ creator, dynamics: [dynamic], comments: { d: [
    { ...comment, replyCount: -1 }, { ...comment, id: 'zero', replyCount: 0 },
  ] }, replies: { d: { root: [
    { ...replies[0]!, id: 'new', publishedAt: '2026-01-02T00:00:00Z', likeCount: 100 },
    { ...replies[0]!, id: '90071992547409932', publishedAt: '2026-01-01T00:00:00Z' },
    { ...replies[0]!, id: '90071992547409931', publishedAt: '2026-01-01T08:00:00+08:00' },
    { ...replies[0]!, id: 'invalid', publishedAt: '2026-02-30T00:00:00Z', likeCount: -1,
      author: { id: 'x', nickname: ' ', avatarUrl: ' ' }, replyTo: { id: 'target', nickname: ' ', avatarUrl: ' ' } },
  ] } } });
  const signal = new AbortController().signal;
  const first = await reader.readReplies({ dynamicId: 'd', rootId: 'root', limit: 100, signal });
  if (first.status !== 'success') throw new Error('Expected success');
  expect(first.data.items.map(item => [item.id, item.publishedAt])).toEqual([
    ['90071992547409931', '2026-01-01T00:00:00.000Z'], ['90071992547409932', '2026-01-01T00:00:00.000Z'], ['new', '2026-01-02T00:00:00.000Z'],
  ]);
  const last = await reader.readReplies({ dynamicId: 'd', rootId: 'root', limit: 10, cursor: first.data.nextCursor, signal });
  if (last.status !== 'success') throw new Error('Expected success');
  expect(last.data.items[0]).toMatchObject({ likeCount: null, publishedAt: null,
    author: { id: 'x', nickname: null, avatarUrl: null }, replyTo: { id: 'target', nickname: null, avatarUrl: null } });
  const comments = await reader.readComments({ dynamicId: 'd', sort: 'hot', signal });
  if (comments.status !== 'success') throw new Error('Expected success');
  expect(comments.data.items.map(item => item.replyCount)).toEqual([null, 0]);
  expect(await reader.readReplies({ dynamicId: 'd', rootId: 'zero', limit: 3, signal })).toEqual({ status: 'success', data: { items: [], nextCursor: null } });
});

it('完整回复集合时间正序和ID并列排序，3/10/10/2分页，标记绑定动态和根评论且同批可重读', async () => {
  const reader = createMockReader({ creator, dynamics: [dynamic], comments: { d: [comment] }, replies: { d: { root: replies } } });
  const signal = new AbortController().signal;
  let cursor: string | null = null;
  const sizes: number[] = [];
  const ids: string[] = [];
  do {
    const input = { dynamicId: 'd', rootId: 'root', limit: cursor === null ? 3 : 10, cursor, signal };
    const result = await reader.readReplies(input);
    if (result.status !== 'success') throw new Error('Expected success');
    expect(await reader.readReplies(input)).toEqual(result);
    sizes.push(result.data.items.length);
    ids.push(...result.data.items.map(item => item.id));
    cursor = result.data.nextCursor;
    if (cursor) {
      expect(await reader.readReplies({ ...input, cursor, rootId: 'other' })).toEqual({ status: 'error' });
      expect(await reader.readReplies({ ...input, cursor, dynamicId: 'other' })).toEqual({ status: 'error' });
    }
  } while (cursor);
  expect(sizes).toEqual([3, 10, 10, 2]);
  expect(ids).toEqual([
    'reply-00', 'reply-01', 'reply-02', 'reply-03', 'reply-04', 'reply-05', 'reply-06', 'reply-07',
    'reply-08', 'reply-09', 'reply-10', 'reply-11', 'reply-12', 'reply-13', 'reply-14', 'reply-15',
    'reply-16', 'reply-17', 'reply-18', 'reply-19', 'reply-20', 'reply-21', 'reply-22', 'reply-23', 'reply-24',
  ]);
  expect(await reader.readReplies({ dynamicId: 'd', rootId: 'root', limit: 10, cursor: 'invalid', signal })).toEqual({ status: 'error' });
  const controller = new AbortController();
  controller.abort();
  expect(await reader.readReplies({ dynamicId: 'd', rootId: 'root', limit: 3, signal: controller.signal })).toEqual({ status: 'cancelled' });
});

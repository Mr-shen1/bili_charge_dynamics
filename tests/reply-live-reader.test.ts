import { describe, expect, it, vi } from 'vitest';
import { createArchiveReader, type ArchiveTransport } from '../src/data/archiveReader';
import { createMockReader, type MockDataset } from '../src/data/mockReader';
import type { DynamicReader, ReadResult, Reply, ReplyBatch } from '../src/data/contracts';

type ReplyInput = Parameters<DynamicReader['readReplies']>[0];
const signal = new AbortController().signal;
const input: ReplyInput = { dynamicId: '100', rootId: '200', page: 2, limit: 10, signal };
const author = { id: '123', nickname: '作者', avatar_url: 'https://example.test/avatar.jpg' };
const root = {
  id: '200', dynamic_id: '100', root_id: '0', parent_id: '0', author,
  text: '根评论', published_at: '2026-03-01T12:00:00+08:00', like_count: 4,
  source_reply_count: 30, comment_locator: null, media_sources: [],
};
const rawReply = (index: number) => ({
  id: String(300 + index), dynamic_id: '100', root_id: '200', parent_id: '200', author,
  text: `回复 ${index}`, published_at: '2026-03-01T12:01:00+08:00', like_count: index, reply_to: null,
});
const body = () => ({
  items: Array.from({ length: 10 }, (_, i) => rawReply(i)), next_cursor: null,
  count: 25, root, source_reply_count: 30, local_reply_count: 25,
  replies_last_attempt: 'success', synced_source_reply_count: 30,
});
function success(result: ReadResult<ReplyBatch>): ReplyBatch {
  if (result.status !== 'success') throw new Error('Expected success');
  return result.data;
}
const invalidPages = [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, null, '2', true];
const invalidLimits = [3, 9, 11, 10.5, NaN, Infinity, null, '10', undefined];
const mixedCursors = ['', 'old-cursor', 0, false, {}];

describe('ArchiveReader 实时回复页', () => {
  it('page URL固定10条并禁用HTTP缓存，同页重复点击再次传输并映射最新根、总数和状态', async () => {
    const transport = vi.fn<ArchiveTransport>()
      .mockResolvedValueOnce(Response.json(body()))
      .mockResolvedValueOnce(Response.json({ ...body(), count: 26, local_reply_count: 26,
        source_reply_count: 31, synced_source_reply_count: 30, replies_last_attempt: 'failed',
        root: { ...root, text: '更新的根', source_reply_count: 31 }, items: [rawReply(20)] }));
    const reader = createArchiveReader(transport);
    const first = success(await reader.readReplies(input));
    const second = success(await reader.readReplies(input));
    expect(transport).toHaveBeenCalledTimes(2);
    for (const [url, init] of transport.mock.calls) {
      expect(url).toBe('/api/archive/dynamics/100/comments/200/replies?page=2&limit=10');
      expect(init).toEqual({ method: 'GET', signal, cache: 'no-store' });
    }
    expect(first).toMatchObject({ count: 25, nextCursor: null, sourceReplyCount: 30, localReplyCount: 25,
      repliesLastAttempt: 'success', syncedSourceReplyCount: 30,
      root: { id: '200', text: '根评论', replyCount: 30, likeCount: 4,
        author: { id: '123', nickname: '作者', avatarUrl: author.avatar_url } },
    });
    expect(first.items).toHaveLength(10);
    expect(first.items[0]).toMatchObject({ id: '300', text: '回复 0', parentId: null, replyTo: null, likeCount: 0 });
    expect(second).toMatchObject({ count: 26, localReplyCount: 26, sourceReplyCount: 31,
      repliesLastAttempt: 'failed', syncedSourceReplyCount: 30,
      root: { id: '200', text: '更新的根', replyCount: 31 }, items: [{ id: '320' }], nextCursor: null });
  });

  it('page首尾及空页仍返回根和非负安全总数，允许null cursor', async () => {
    const transport = vi.fn<ArchiveTransport>(async () => Response.json({ ...body(), count: 0, items: [] }));
    const reader = createArchiveReader(transport);
    for (const page of [1, Number.MAX_SAFE_INTEGER]) {
      expect(success(await reader.readReplies({ ...input, page, cursor: null }))).toMatchObject({
        items: [], count: 0, root: { id: '200' }, nextCursor: null,
      });
    }
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(invalidPages)('非法page %s 在传输前拒绝', async page => {
    const transport = vi.fn<ArchiveTransport>();
    const reader = createArchiveReader(transport);
    expect(await reader.readReplies({ ...input, page: page as number })).toEqual({ status: 'error' });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(invalidLimits)('page模式非法limit %s 在传输前拒绝', async limit => {
    const transport = vi.fn<ArchiveTransport>();
    expect(await createArchiveReader(transport).readReplies({ ...input, limit: limit as number })).toEqual({ status: 'error' });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(mixedCursors)('page不能混用cursor %s', async cursor => {
    const transport = vi.fn<ArchiveTransport>();
    expect(await createArchiveReader(transport).readReplies({ ...input, cursor: cursor as string })).toEqual({ status: 'error' });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([undefined, null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '25', true])('拒绝坏count %s', async count => {
    const reader = createArchiveReader(async () => Response.json({ ...body(), count }));
    expect(await reader.readReplies(input)).toEqual({ status: 'error' });
  });
  it.each([undefined, null, { ...root, id: '201' }, { ...root, dynamic_id: '101' }, { id: '200' }])(
    '每页必须有匹配当前根的完整root %j', async invalidRoot => {
      const reader = createArchiveReader(async () => Response.json({ ...body(), root: invalidRoot }));
      expect(await reader.readReplies(input)).toEqual({ status: 'error' });
    },
  );
  it.each(['cursor', '', undefined, 0])('page响应next_cursor必须严格为null而非 %s', async next_cursor => {
    const reader = createArchiveReader(async () => Response.json({ ...body(), next_cursor }));
    expect(await reader.readReplies(input)).toEqual({ status: 'error' });
  });
  it('拒绝超过10条、重复或串根回复', async () => {
    for (const items of [
      Array.from({ length: 11 }, (_, i) => rawReply(i)),
      [rawReply(0), rawReply(0)],
      [{ ...rawReply(0), root_id: '201' }],
    ]) {
      expect(await createArchiveReader(async () => Response.json({ ...body(), items })).readReplies(input)).toEqual({ status: 'error' });
    }
  });

  it('已取消不传输；传输忽略信号、解析迟到或抛错也优先取消', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn<ArchiveTransport>();
    expect(await createArchiveReader(transport).readReplies({ ...input, signal: controller.signal })).toEqual({ status: 'cancelled' });
    expect(transport).not.toHaveBeenCalled();

    for (const late of ['success', 'bad-json', 'http-error', 'throw', 'json'] as const) {
      const pending = new AbortController();
      const reader = createArchiveReader(async (_url, init) => {
        expect(init.signal).toBe(pending.signal);
        if (late === 'json') {
          const response = Response.json(body());
          vi.spyOn(response, 'json').mockImplementation(async () => {
            pending.abort();
            return body();
          });
          return response;
        }
        await Promise.resolve();
        pending.abort();
        if (late === 'throw') throw new Error('Ignored abort');
        if (late === 'bad-json') return new Response('{');
        return Response.json(body(), { status: late === 'http-error' ? 500 : 200 });
      });
      expect(await reader.readReplies({ ...input, signal: pending.signal })).toEqual({ status: 'cancelled' });
    }
  });

  it('保留旧cursor首3续10、查询参数、无count/root响应及错误映射', async () => {
    const transport = vi.fn<ArchiveTransport>()
      .mockResolvedValueOnce(Response.json({ items: [rawReply(0)], next_cursor: 'old:+/=' }))
      .mockResolvedValueOnce(Response.json({ items: [rawReply(1)], next_cursor: null }))
      .mockResolvedValueOnce(Response.json({ error: { code: 'CURSOR_INVALID' } }, { status: 422 }));
    const reader = createArchiveReader(transport);
    const first = success(await reader.readReplies({ ...input, page: undefined, limit: 3 }));
    expect(first.nextCursor).toBe('old:+/=');
    expect(first).not.toHaveProperty('count');
    expect(first).not.toHaveProperty('root');
    const cursorInput = { ...input, page: undefined, cursor: first.nextCursor };
    expect(success(await reader.readReplies(cursorInput)).items[0]?.id).toBe('301');
    expect(await reader.readReplies(cursorInput)).toEqual({ status: 'error', reason: 'invalid-cursor' });
    expect(transport.mock.calls[0]?.[0]).toBe('/api/archive/dynamics/100/comments/200/replies?limit=3');
    expect(transport.mock.calls[1]?.[0]).toBe('/api/archive/dynamics/100/comments/200/replies?limit=10&cursor=old%3A%2B%2F%3D');
    expect(transport.mock.calls.every(([, init]) => init.cache === undefined)).toBe(true);
  });
});

const creator = { id: 'up', nickname: '作者', avatarUrl: null };
const comment = { id: 'root', author: creator, publishedAt: null, text: '根', likeCount: 0, replyCount: 30 };
const mockReply = (index: number): Reply => ({
  id: `reply-${String(index).padStart(2, '0')}`, author: creator,
  publishedAt: '2026-01-01T00:00:00Z', text: `回复 ${index}`, likeCount: 0, replyTo: null,
});
function mockDataset() {
  return {
    creator, dynamics: [{ id: 'd', author: creator, publishedAt: null, text: '', commentCount: 26 }],
    comments: { d: [{ ...comment }] },
    replies: { d: { root: Array.from({ length: 25 }, (_, i) => mockReply(i)).reverse() } },
  } satisfies MockDataset;
}
const mockInput: ReplyInput = { dynamicId: 'd', rootId: 'root', page: 1, limit: 10, signal };

describe('MockReader 实时回复页', () => {
  it('支持既有非数字ID，同页重读映射最新dataset及根，不建立缓存', async () => {
    const dataset = mockDataset();
    const reader = createMockReader(dataset);
    const first = success(await reader.readReplies(mockInput));
    expect(first).toMatchObject({ count: 25, localReplyCount: 25, sourceReplyCount: 30,
      nextCursor: null, root: { id: 'root', text: '根', replyCount: 30 } });
    expect(first.items.map(item => item.id)).toEqual(Array.from({ length: 10 }, (_, i) => mockReply(i).id));

    dataset.replies.d.root = [{ ...mockReply(99), publishedAt: '2025-12-31T00:00:00Z',
      author: { id: 'x', nickname: ' ', avatarUrl: ' ' }, likeCount: -1,
      replyTo: { id: 'y', nickname: ' ', avatarUrl: ' ' } }, ...dataset.replies.d.root];
    dataset.comments.d[0] = { ...comment, text: '新根', replyCount: 31 };
    const second = success(await reader.readReplies(mockInput));
    expect(second).toMatchObject({ count: 26, localReplyCount: 26, sourceReplyCount: 31,
      root: { text: '新根', replyCount: 31 } });
    expect(second.items[0]).toMatchObject({ id: 'reply-99', likeCount: null,
      publishedAt: '2025-12-31T00:00:00.000Z', author: { id: 'x', nickname: null, avatarUrl: null },
      replyTo: { id: 'y', nickname: null, avatarUrl: null } });
    expect(first.count).toBe(25);
    expect(first.items[0]?.id).toBe('reply-00');
  });

  it('时间正序、同刻ID排序、坏时间置后，跨页10/10/5且每页带根和总数', async () => {
    const dataset = mockDataset();
    dataset.replies.d.root = dataset.replies.d.root.map(item => item.id === 'reply-00'
      ? { ...item, publishedAt: 'invalid' } : item.id === 'reply-24'
        ? { ...item, publishedAt: '2025-12-31T00:00:00Z' } : item);
    const reader = createMockReader(dataset);
    const pages = [];
    for (const page of [1, 2, 3, 4]) {
      const batch = success(await reader.readReplies({ ...mockInput, page, cursor: null }));
      expect(batch).toMatchObject({ root: { id: 'root' }, count: 25, localReplyCount: 25, sourceReplyCount: 30, nextCursor: null });
      pages.push(batch.items);
    }
    expect(pages.map(items => items.length)).toEqual([10, 10, 5, 0]);
    expect(pages.flat().map(item => item.id)).toEqual([
      'reply-24', ...Array.from({ length: 23 }, (_, i) => mockReply(i + 1).id), 'reply-00',
    ]);
  });

  it('来源数未知时回退本地总数，已知零数不被覆盖', async () => {
    for (const replyCount of [null, 0]) {
      const dataset: MockDataset = { ...mockDataset(), comments: { d: [{ ...comment, replyCount }] } };
      const batch = success(await createMockReader(dataset).readReplies(mockInput));
      expect(batch.sourceReplyCount).toBe(replyCount ?? 25);
      expect(batch.count).toBe(25);
    }
  });

  it.each(invalidPages)('严格拒绝非法page %s', async page => {
    expect(await createMockReader(mockDataset()).readReplies({ ...mockInput, page: page as number })).toEqual({ status: 'error' });
  });
  it.each(invalidLimits)('page模式严格拒绝非法limit %s', async limit => {
    expect(await createMockReader(mockDataset()).readReplies({ ...mockInput, limit: limit as number })).toEqual({ status: 'error' });
  });
  it.each(mixedCursors)('page模式拒绝混用cursor %s', async cursor => {
    expect(await createMockReader(mockDataset()).readReplies({ ...mockInput, cursor: cursor as string })).toEqual({ status: 'error' });
  });
  it('取消优先，旧cursor仍按3/10/10/2读取且不附加page字段', async () => {
    const reader = createMockReader(mockDataset());
    const controller = new AbortController();
    controller.abort();
    expect(await reader.readReplies({ ...mockInput, signal: controller.signal })).toEqual({ status: 'cancelled' });
    let cursor: string | null = null;
    const sizes: number[] = [];
    const ids: string[] = [];
    do {
      const oldInput: ReplyInput = { ...mockInput, page: undefined, cursor, limit: cursor === null ? 3 : 10 };
      const batch = success(await reader.readReplies(oldInput));
      expect(await reader.readReplies(oldInput)).toEqual({ status: 'success', data: batch });
      expect(batch).not.toHaveProperty('count');
      expect(batch).not.toHaveProperty('root');
      sizes.push(batch.items.length);
      ids.push(...batch.items.map(item => item.id));
      cursor = batch.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([3, 10, 10, 2]);
    expect(ids).toEqual(Array.from({ length: 25 }, (_, i) => mockReply(i).id));
    expect(await reader.readReplies({ ...mockInput, page: undefined, cursor: 'invalid' })).toEqual({ status: 'error' });
  });
});

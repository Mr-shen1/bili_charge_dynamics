import { expect, it } from 'vitest';
import { createArchiveReader } from '../../src/data/archiveReader';
import type { Comment } from '../../src/data/contracts';
import { archiveComment } from '../fixtures/comments';

function signature(url: string): string {
  return new URL(url, 'http://local').pathname + new URL(url, 'http://local').search;
}

it('两种排序都按 20/20/5 读取，cursor 不透明编码且只带排序与 limit', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const all = Array.from({ length: 45 }, (_value, index) => archiveComment(index + 1));
  const reader = createArchiveReader(async (url, init) => {
    requests.push({ url, init });
    const cursor = new URL(url, 'http://local').searchParams.get('cursor');
    const offset = cursor === null ? 0 : cursor === 'c20' ? 20 : 40;
    return Response.json({
      items: all.slice(offset, Math.min(offset + 20, all.length)),
      next_cursor: offset + 20 < all.length ? `c${offset + 20}` : null,
    });
  });

  for (const sort of ['hot', 'latest'] as const) {
    const ids: string[] = [];
    let cursor: string | null | undefined;
    for (let batch = 0; batch < 5; batch += 1) {
      const result = await reader.readComments({
        dynamicId: '1001', sort, cursor, signal: new AbortController().signal,
      });
      if (result.status !== 'success') throw new Error('读取应成功');
      ids.push(...result.data.items.map(item => item.id));
      cursor = result.data.nextCursor;
      if (cursor === null) break;
    }
    expect(ids).toEqual(all.map(item => item.id));
  }

  expect(requests.map(request => signature(request.url))).toEqual([
    '/api/archive/dynamics/1001/comments?sort=hot&limit=20',
    '/api/archive/dynamics/1001/comments?sort=hot&limit=20&cursor=c20',
    '/api/archive/dynamics/1001/comments?sort=hot&limit=20&cursor=c40',
    '/api/archive/dynamics/1001/comments?sort=latest&limit=20',
    '/api/archive/dynamics/1001/comments?sort=latest&limit=20&cursor=c20',
    '/api/archive/dynamics/1001/comments?sort=latest&limit=20&cursor=c40',
  ]);
  expect(requests.every(request => request.init.method === 'GET')).toBe(true);
  expect(requests[0]!.init.signal).toBeInstanceOf(AbortSignal);
});

it('不透明 cursor 原样编码，缺失与非法字段按未知处理而不伪造', async () => {
  const urls: string[] = [];
  const reader = createArchiveReader(async (url) => {
    urls.push(url);
    return Response.json({
      items: [archiveComment(1, {
        is_pinned: true,
        author: { id: null, nickname: null, avatar_url: 'javascript:alert(1)' },
        text: null,
        published_at: '2026-02-30T10:03:04+08:00',
        like_count: null,
        source_reply_count: null,
        media_sources: [{ url: 'https://upstream.example.test/a.jpg', width: null, height: null }],
      })],
      next_cursor: null,
    });
  });

  const first = await reader.readComments({
    dynamicId: '1001', sort: 'hot', cursor: 'opaque+/=', signal: new AbortController().signal,
  });
  expect(urls[0]).toBe('/api/archive/dynamics/1001/comments?sort=hot&limit=20&cursor=opaque%2B%2F%3D');
  if (first.status !== 'success') throw new Error('读取应成功');
  const item = first.data.items[0] as Comment;
  expect(item).toMatchObject({
    id: '5001', isPinned: true, author: { id: '', nickname: null, avatarUrl: null },
    publishedAt: null, text: '', likeCount: null, replyCount: null, pendingMediaCount: 1,
  });
  // 旧冻结评论没有 media：不把来源地址当作当前图片，也不猜上传状态。
  expect(item.images).toBeUndefined();
});

const errorCases: { name: string; response: () => Response; reason?: 'invalid-cursor' }[] = [
  { name: '光标失效', response: () => Response.json({ error: { code: 'CURSOR_INVALID' } }, { status: 422 }), reason: 'invalid-cursor' },
  { name: '无效参数', response: () => Response.json({ error: { code: 'INVALID_INPUT' } }, { status: 422 }) },
  { name: '动态不存在', response: () => Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }) },
  { name: '服务不可用', response: () => Response.json({ error: { code: 'UNAVAILABLE' } }, { status: 503 }) },
  { name: '坏 DTO', response: () => Response.json({ items: [archiveComment(1, { root_id: '9' })], next_cursor: null }) },
  { name: '超过 20 条', response: () => Response.json({ items: Array.from({ length: 21 }, (_v, i) => archiveComment(i + 1)), next_cursor: null }) },
  { name: '批内重复', response: () => Response.json({ items: [archiveComment(1), archiveComment(1)], next_cursor: null }) },
  { name: 'next_cursor 非字符串', response: () => Response.json({ items: [], next_cursor: 20 }) },
];

for (const item of errorCases) {
  it(`${item.name} 折叠为安全读取错误`, async () => {
    const reader = createArchiveReader(async () => item.response());
    const result = await reader.readComments({
      dynamicId: '1001', sort: 'hot', signal: new AbortController().signal,
    });
    expect(result).toEqual(item.reason ? { status: 'error', reason: item.reason } : { status: 'error' });
  });
}

it('传输异常不回显原始错误，已取消优先且不再发新请求', async () => {
  const throwing = createArchiveReader(async () => { throw new Error('SECRET_TOKEN'); });
  const failed = await throwing.readComments({
    dynamicId: '1001', sort: 'latest', signal: new AbortController().signal,
  });
  expect(failed).toEqual({ status: 'error' });

  const controller = new AbortController();
  controller.abort();
  let called = 0;
  const cancelled = createArchiveReader(async () => { called += 1; return Response.json({}); });
  expect(await cancelled.readComments({
    dynamicId: '1001', sort: 'hot', signal: controller.signal,
  })).toEqual({ status: 'cancelled' });
  expect(called).toBe(0);
});

it('非法入参不进入 HTTP', async () => {
  let called = 0;
  const reader = createArchiveReader(async () => { called += 1; return Response.json({ items: [], next_cursor: null }); });
  const signal = new AbortController().signal;
  expect(await reader.readComments({ dynamicId: 'not-an-id', sort: 'hot', signal }))
    .toEqual({ status: 'error' });
  expect(await reader.readComments({ dynamicId: '1001', sort: 'wrong' as never, signal }))
    .toEqual({ status: 'error' });
  expect(await reader.readComments({ dynamicId: '1001', sort: 'hot', cursor: 5 as never, signal }))
    .toEqual({ status: 'error' });
  expect(called).toBe(0);
});

it('楼中楼 UP 摘要映射该动态作者的最早回复：保留目标与身份，直接回根不带目标', async () => {
  const reader = createArchiveReader(async () => Response.json({
    items: [
      archiveComment(1, {
        source_reply_count: 25,
        up_reply: {
          id: '9100',
          author: { id: '123', nickname: '动态作者', avatar_url: null },
          parent_id: '9099',
          reply_to: { id: '7100', nickname: '阿蓝', avatar_url: null },
          published_at: '2026-03-01T10:03:04+08:00',
          text: '回复 @阿蓝: UP 的最早回复',
          like_count: 3,
        },
      }),
      archiveComment(2, {
        source_reply_count: 4,
        up_reply: {
          id: '9101',
          author: { id: '123', nickname: '动态作者', avatar_url: null },
          parent_id: '5002',
          reply_to: null,
          published_at: null,
          text: '直接回根',
          like_count: null,
        },
      }),
      // 作者未参与该楼时来源不给摘要；缺失与显式 null 都按无预览处理。
      archiveComment(3, { source_reply_count: 2 }),
      archiveComment(4, { source_reply_count: 2, up_reply: null }),
    ],
    next_cursor: null,
  }));

  const result = await reader.readComments({
    dynamicId: '1001', sort: 'hot', signal: new AbortController().signal,
  });
  if (result.status !== 'success') throw new Error('读取应成功');
  const [nested, direct, missing, explicitNull] = result.data.items;
  expect(nested!.upReply).toEqual({
    id: '9100',
    author: { id: '123', nickname: '动态作者', avatarUrl: null },
    publishedAt: '2026-03-01T10:03:04+08:00',
    text: '回复 @阿蓝: UP 的最早回复',
    likeCount: 3,
    replyTo: { id: '7100', nickname: '阿蓝', avatarUrl: null },
    parentId: '9099',
  });
  // 直接回根没有嵌套目标；时间与点赞缺失按未知保留。
  expect(direct!.upReply).toMatchObject({ parentId: null, replyTo: null, publishedAt: null, likeCount: null });
  expect(missing!.upReply).toBeUndefined();
  expect(explicitNull!.upReply).toBeNull();
});

it('楼中楼摘要结构不完整或指向根评论自身时不展示，也不回退成伪造内容', async () => {
  const reader = createArchiveReader(async () => Response.json({
    items: [
      archiveComment(1, { up_reply: { id: '5001', text: '自指' } }),
      archiveComment(2, { up_reply: { id: '9100', author: { id: '123' }, text: '缺正文时间' } }),
      archiveComment(3, { up_reply: { id: '9101', author: { id: '123' }, text: 'x', reply_to: { id: 'oops' } } }),
    ],
    next_cursor: null,
  }));
  const result = await reader.readComments({
    dynamicId: '1001', sort: 'hot', signal: new AbortController().signal,
  });
  if (result.status !== 'success') throw new Error('读取应成功');
  // 摘要不完整只影响该预览字段，不把整批评论判为坏 DTO。
  expect(result.data.items.map(item => item.upReply ?? null)).toEqual([null, null, null]);
});

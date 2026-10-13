import { describe, expect, it, vi } from 'vitest';
import { createArchiveReader } from '../src/data/archiveReader';

import { archive } from './fixtures/archive';
const signal = new AbortController().signal;
const rootComment = {
  id: '900719925474099398765', dynamic_id: archive.id, root_id: '0', parent_id: '0',
  author: { id: '123', nickname: '归档作者', avatar_url: 'https://avatar.example.test/user.jpg' },
  published_at: '2026-03-01T12:03:04+08:00', text: '<script>not executable</script>\n评论 😀 https://example.test',
  like_count: 0, source_reply_count: 25,
  comment_locator: { oid: '900719925474099312345', type: 17 },
  media_sources: [{ url: 'https://upstream.example.test/comment.jpg', width: 800, height: 600 }],
};
const reply = {
  id: '900719925474099399999', dynamic_id: archive.id, root_id: rootComment.id, parent_id: rootComment.id,
  author: rootComment.author, published_at: rootComment.published_at, text: rootComment.text,
  like_count: 0, reply_to: { id: '456', nickname: '回复目标', avatar_url: 'https://avatar.example.test/target.jpg' },
};
describe('生产 ArchiveReader', () => {
  it('根评论保留自己的有序图片组与上传状态，不混入动态、其他根评论或回复', async () => {
    const publicUrl = 'https://oss.example.test/comment/a%20b.jpg';
    const media = [
      { id: 'comment-third', owner: { type: 'comment', id: rootComment.id }, status: 'success', public_url: publicUrl, width: 800, height: 2400 },
      { id: 'comment-first', owner: { type: 'comment', id: rootComment.id }, status: 'pending', public_url: publicUrl, width: null, height: null },
      { id: 'comment-second', owner: { type: 'comment', id: rootComment.id }, status: 'failed', public_url: publicUrl, width: 400, height: 300 },
      { id: 'dynamic', owner: { type: 'dynamic', id: archive.id }, status: 'success', public_url: publicUrl },
      { id: 'other-root', owner: { type: 'comment', id: '999' }, status: 'success', public_url: publicUrl },
      { id: 'reply', owner: { type: 'reply', id: rootComment.id }, status: 'success', public_url: publicUrl },
    ];
    const reader = createArchiveReader(async () => Response.json({ items: [{ ...rootComment, text: '',
      media_sources: media.slice(0, 3).map(() => ({ url: 'https://source.example.test/not-a-fallback.jpg', width: null, height: null })),
      media, previous_media: [media[0]] }], next_cursor: null }));
    expect(await reader.readComments({ dynamicId: archive.id, sort: 'hot', signal })).toMatchObject({ status: 'success', data: {
      items: [{ id: rootComment.id, text: '', pendingMediaCount: 0, images: [
        { id: 'comment-third', thumbnailUrl: publicUrl, previewUrl: publicUrl, width: 800, height: 2400, archiveStatus: 'success' },
        { id: 'comment-first', thumbnailUrl: null, previewUrl: null, width: null, height: null, archiveStatus: 'pending' },
        { id: 'comment-second', thumbnailUrl: null, previewUrl: null, width: 400, height: 300, archiveStatus: 'failed' },
      ] }], nextCursor: null,
    } });
  });
  it('评论十二图不截断，坏地址局部降级，旧冻结来源仍待归档且不回退旧成功组', async () => {
    const media = Array.from({ length: 12 }, (_, index) => ({ id: `comment-${index}`,
      owner: { type: 'comment', id: rootComment.id }, status: 'success',
      public_url: 'https://oss.example.test/comment.jpg', width: null, height: null }));
    const read = (item: unknown) => createArchiveReader(async () => Response.json({ items: [item], next_cursor: null }))
      .readComments({ dynamicId: archive.id, sort: 'hot', signal });
    const full = await read({ ...rootComment, media });
    if (full.status !== 'success') throw new Error('Expected readable comments');
    expect(full.data.items[0]?.images).toHaveLength(12);
    expect(full.data.items[0]?.images?.map(image => image.id)).toEqual([
      'comment-0', 'comment-1', 'comment-2', 'comment-3', 'comment-4', 'comment-5',
      'comment-6', 'comment-7', 'comment-8', 'comment-9', 'comment-10', 'comment-11',
    ]);
    for (const public_url of ['http://oss.example.test/image.jpg', 'javascript:FICTIONAL_SECRET',
      'https://user:FICTIONAL_SECRET@oss.example.test/image.jpg', '//oss.example.test/image.jpg', null]) {
      expect(await read({ ...rootComment, media: [{ ...media[0], public_url }] })).toMatchObject({ status: 'success', data: {
        items: [{ text: rootComment.text, images: [{ archiveStatus: 'success', thumbnailUrl: null, previewUrl: null }] }],
      } });
    }
    expect(await read({ ...rootComment, media: [media[0], media[0], { ...media[0], id: '', status: 'success' },
      { ...media[0], id: 'invalid-status', status: 'unknown' }] })).toMatchObject({ status: 'success', data: {
        items: [{ images: [{ id: 'comment-0' }] }],
      } });
    expect(await read({ ...rootComment, previous_media: media })).toMatchObject({ status: 'success', data: {
      items: [{ pendingMediaCount: 1 }],
    } });
    const legacy = await read({ ...rootComment, previous_media: media });
    if (legacy.status !== 'success') throw new Error('Expected readable legacy comments');
    expect(legacy.data.items[0]?.images).toBeUndefined();
  });
  it('保留当前媒体整组、顺序和上传状态，只暴露成功的公开 URL，不回退来源或旧组', async () => {
    const publicUrl = 'https://oss.example.test/bucket/a%20b.jpg?literal=1';
    const media = Array.from({ length: 12 }, (_, position) => ({
      id: `media-${position}`, owner: { type: 'dynamic', id: archive.id }, position,
      source_url: `https://upstream.example.test/${position}.jpg`, width: position === 0 ? 800 : null,
      height: position === 0 ? 1200 : null, version: 'v2',
      status: position === 1 ? 'pending' : position === 2 ? 'failed' : 'success',
      public_url: position === 1 || position === 2 ? null : publicUrl,
      error: position === 2 ? 'MEDIA_UPLOAD_FAILED' : null,
    }));
    const raw = { ...archive, media, previous_media: [{ ...media[0], id: 'previous', public_url: 'https://old.example.test/old.jpg' }] };
    const reader = createArchiveReader(async path => Response.json(path.includes('?') ? { items: [raw], next_cursor: null } : raw));
    const detail = await reader.readDetail({ id: archive.id, signal });
    expect(detail).toMatchObject({ status: 'success', data: { text: archive.text, images: [
      { id: 'media-0', thumbnailUrl: publicUrl, previewUrl: publicUrl, width: 800, height: 1200, archiveStatus: 'success' },
      { id: 'media-1', thumbnailUrl: null, previewUrl: null, width: null, height: null, archiveStatus: 'pending' },
      { id: 'media-2', thumbnailUrl: null, previewUrl: null, width: null, height: null, archiveStatus: 'failed' },
      ...Array.from({ length: 9 }, (_, i) => ({ id: `media-${i + 3}`, thumbnailUrl: publicUrl, previewUrl: publicUrl,
        width: null, height: null, archiveStatus: 'success' })),
    ] } });
    if (detail.status !== 'success') throw new Error('Expected readable detail');
    expect(await reader.readList({ scope: { kind: 'all' }, limit: 10, signal })).toEqual({ status: 'success',
      data: { items: [detail.data], nextCursor: null } });
  });
  it('图片地址损坏局部降级，不伤正文；未成功公开地址、来源、旧组与异 owner 永不补图', async () => {
    const media = {
      id: 'image-1', owner: { type: 'dynamic', id: archive.id }, position: 0,
      source_url: 'https://source.example.test/not-a-fallback.jpg', width: null, height: null,
      version: null, status: 'success', public_url: 'https://oss.example.test/accepted.jpg', error: null,
    };
    for (const public_url of ['http://oss.example.test/insecure.jpg', 'javascript:SECRET_TOKEN', 'data:image/svg+xml,SECRET_TOKEN',
      'https://user:SECRET_TOKEN@oss.example.test/image.jpg', '//oss.example.test/image.jpg', null]) {
      const reader = createArchiveReader(async () => Response.json({ ...archive, media: [{ ...media, public_url }] }));
      expect(await reader.readDetail({ id: archive.id, signal })).toMatchObject({ status: 'success', data: {
        text: archive.text, images: [{ id: 'image-1', archiveStatus: 'success', thumbnailUrl: null, previewUrl: null }],
      } });
    }
    for (const status of ['pending', 'failed']) {
      expect(await createArchiveReader(async () => Response.json({ ...archive, media: [{ ...media, status }] }))
        .readDetail({ id: archive.id, signal })).toMatchObject({ status: 'success', data: {
          images: [{ archiveStatus: status, thumbnailUrl: null, previewUrl: null }],
        } });
    }
    for (const owner of [{ type: 'comment', id: archive.id }, { type: 'dynamic', id: '999' }]) {
      expect(await createArchiveReader(async () => Response.json({ ...archive, media: [{ ...media, owner }], previous_media: [media] }))
        .readDetail({ id: archive.id, signal })).toMatchObject({ status: 'success', data: { text: archive.text, images: [] } });
    }
  });
  it('回复来源数、本地数与逐根失败元信息独立，不把首次失败当已成功空归档', async () => {
    const reader = createArchiveReader(async () => Response.json({ items: [], next_cursor: null,
      source_reply_count: null, local_reply_count: 0, replies_last_attempt: 'failed', synced_source_reply_count: null }));
    expect(await reader.readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit: 3, signal })).toEqual({ status: 'success', data: {
      items: [], nextCursor: null, sourceReplyCount: null, localReplyCount: 0, repliesLastAttempt: 'failed', syncedSourceReplyCount: null,
    } });
  });
  it('回复 DTO 通过真实 Adapter 映射大 ID、普通文本和目标作者，未知目标不伪造', async () => {
    const reader = createArchiveReader(async () => Response.json({ items: [reply, { ...reply, id: '2', parent_id: null,
      author: { id: null, nickname: null, avatar_url: null }, text: null, published_at: null,
      like_count: null, reply_to: null }], next_cursor: null }));
    expect(await reader.readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit: 3, signal })).toEqual({ status: 'success', data: {
      items: [{ id: '900719925474099399999', author: { id: '123', nickname: '归档作者', avatarUrl: 'https://avatar.example.test/user.jpg' },
        publishedAt: '2026-03-01T12:03:04+08:00', text: '<script>not executable</script>\n评论 😀 https://example.test',
        likeCount: 0, replyTo: { id: '456', nickname: '回复目标', avatarUrl: 'https://avatar.example.test/target.jpg' } },
      { id: '2', author: { id: '', nickname: null, avatarUrl: null }, publishedAt: null, text: '', likeCount: null, replyTo: null }],
      nextCursor: null,
    } });
  });
  it('25 条回复保持服务端顺序，累计 3/13/23/25，cursor 编码且无客户端 TTL', async () => {
    const pages = [
      [reply, { ...reply, id: '9' }, { ...reply, id: '10' }],
      Array.from({ length: 10 }, (_, i) => ({ ...reply, id: String(11 + i) })),
      Array.from({ length: 10 }, (_, i) => ({ ...reply, id: String(21 + i) })),
      [{ ...reply, id: '31' }, { ...reply, id: '32' }],
    ];
    const requests: string[] = [];
    const cursors = ['opaque+/=', 'second?&=', 'last#%=', null];
    const reader = createArchiveReader(async (url, init) => {
      expect(init).toEqual({ method: 'GET', signal });
      requests.push(url);
      const cursor = new URL(url, 'https://archive.example.test').searchParams.get('cursor');
      const index = cursor === null ? 0 : cursors.indexOf(cursor) + 1;
      return Response.json({ items: pages[index], next_cursor: cursors[index] });
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
      const first = await reader.readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit: 3, cursor: null, signal });
      expect(first).toMatchObject({ status: 'success', data: { nextCursor: 'opaque+/=' } });
      vi.setSystemTime(new Date('2026-03-03T00:00:00Z'));
      const second = await reader.readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit: 10, cursor: 'opaque+/=', signal });
      const third = await reader.readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit: 10, cursor: 'second?&=', signal });
      const last = await reader.readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit: 10, cursor: 'last#%=', signal });
      const ids: string[] = [];
      const sizes: number[] = [];
      for (const result of [first, second, third, last]) {
        expect(result.status).toBe('success');
        if (result.status === 'success') ids.push(...result.data.items.map(item => item.id));
        sizes.push(ids.length);
      }
      expect(sizes).toEqual([3, 13, 23, 25]);
      expect(ids).toEqual(['900719925474099399999', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
        '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32']);
      expect(last).toMatchObject({ status: 'success', data: { nextCursor: null } });
      expect(requests).toEqual([
        '/api/archive/dynamics/900719925474099312345/comments/900719925474099398765/replies?limit=3',
        '/api/archive/dynamics/900719925474099312345/comments/900719925474099398765/replies?limit=10&cursor=opaque%2B%2F%3D',
        '/api/archive/dynamics/900719925474099312345/comments/900719925474099398765/replies?limit=10&cursor=second%3F%26%3D',
        '/api/archive/dynamics/900719925474099312345/comments/900719925474099398765/replies?limit=10&cursor=last%23%25%3D',
      ]);
      expect(await reader.readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit: 10, cursor: 'opaque+/=', signal })).toEqual(second);
    } finally { vi.useRealTimers(); }
  });
  it('回复普通失败保留原 cursor 可重试，不自动改首批或伪装成功空', async () => {
    for (const fail of [async () => new Response('SECRET_TOKEN'),
      async () => Response.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 503 }),
      async () => { throw new Error('SECRET_TOKEN'); }]) {
      const requests: string[] = [];
      const reader = createArchiveReader(async url => {
        requests.push(url);
        return requests.length === 1 ? fail() : Response.json({ items: [reply], next_cursor: null });
      });
      const input = { dynamicId: archive.id, rootId: rootComment.id, limit: 10, cursor: 'same+/=', signal };
      expect(await reader.readReplies(input)).toEqual({ status: 'error' });
      expect(await reader.readReplies(input)).toMatchObject({ status: 'success', data: { items: [{ id: reply.id }], nextCursor: null } });
      expect(requests).toEqual([
        '/api/archive/dynamics/900719925474099312345/comments/900719925474099398765/replies?limit=10&cursor=same%2B%2F%3D',
        '/api/archive/dynamics/900719925474099312345/comments/900719925474099398765/replies?limit=10&cursor=same%2B%2F%3D',
      ]);
    }
  });
  it('回复预先取消不发 HTTP，忽略 signal 的传输/JSON 成功、失败、异常仍以取消优先', async () => {
    const cancelled = new AbortController(); cancelled.abort();
    const requests: string[] = [];
    const reader = createArchiveReader(async url => { requests.push(url); throw new Error('SECRET_TOKEN'); });
    expect(await reader.readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit: 3, signal: cancelled.signal })).toEqual({ status: 'cancelled' });
    expect(requests).toEqual([]);
    for (const response of [Response.json({ items: [reply], next_cursor: null }),
      Response.json({ error: { code: 'CURSOR_INVALID', message: 'SECRET_TOKEN' } }, { status: 422 }), new Response('SECRET_TOKEN')]) {
      const controller = new AbortController();
      const late = createArchiveReader(async () => { controller.abort(); return response; });
      expect(await late.readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit: 3, signal: controller.signal })).toEqual({ status: 'cancelled' });
    }
    const controller = new AbortController();
    const throwing = createArchiveReader(async () => { controller.abort(); throw new Error('SECRET_TOKEN'); });
    expect(await throwing.readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit: 3, signal: controller.signal })).toEqual({ status: 'cancelled' });
    for (const rejects of [false, true]) {
      const duringJson = new AbortController();
      const response = Response.json({});
      response.json = async () => {
        duringJson.abort();
        if (rejects) throw new Error('SECRET_TOKEN');
        return { items: [reply], next_cursor: null };
      };
      expect(await createArchiveReader(async () => response).readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit: 3, signal: duringJson.signal }))
        .toEqual({ status: 'cancelled' });
    }
  });
  it('回复与目标作者缺失信息独立兜底，头像/时间安全处理且不暴露回复图片', async () => {
    for (const avatar_url of ['javascript:SECRET_TOKEN', 'data:image/svg+xml,SECRET_TOKEN', 'http://avatar.example.test/user.jpg',
      'https://user:SECRET_TOKEN@avatar.example.test/user.jpg', '//avatar.example.test/user.jpg']) {
      const reader = createArchiveReader(async () => Response.json({ items: [{ ...reply, text: '',
        author: { ...reply.author, nickname: ' ', avatar_url },
        reply_to: { id: null, nickname: ' ', avatar_url }, published_at: '2026-02-30T12:03:04+08:00',
        media_sources: [{ url: 'javascript:SECRET_TOKEN' }],
      }], next_cursor: null }));
      expect(await reader.readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit: 3, signal })).toEqual({ status: 'success', data: {
        items: [{ id: '900719925474099399999', author: { id: '123', nickname: null, avatarUrl: null },
          text: '', publishedAt: null, likeCount: 0, replyTo: null }], nextCursor: null,
      } });
    }
  });
  it('回复仅将 HTTP 422 CURSOR_INVALID 映射为标记无效，不重读首批或回显错误', async () => {
    for (const [status, code, reason] of [
      [422, 'CURSOR_INVALID', 'invalid-cursor'], [422, 'INVALID_INPUT', undefined],
      [503, 'CURSOR_INVALID', undefined], [404, 'NOT_FOUND', undefined], [200, 'CURSOR_INVALID', undefined],
    ] as const) {
      const requests: string[] = [];
      const reader = createArchiveReader(async url => {
        requests.push(url); return Response.json({ error: { code, message: 'SECRET_TOKEN' } }, { status });
      });
      expect(await reader.readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit: 10, cursor: 'broken+/=', signal }))
        .toEqual(reason ? { status: 'error', reason } : { status: 'error' });
      expect(requests).toEqual(['/api/archive/dynamics/900719925474099312345/comments/900719925474099398765/replies?limit=10&cursor=broken%2B%2F%3D']);
    }
  });
  it('回复坏 DTO 整批拒绝：重复项、批量溢出、串父级、非法关系和缺字段', async () => {
    const malformed = [null, {}, { ...reply, id: 123 }, { ...reply, id: '01' }, { ...reply, id: rootComment.id },
      { ...reply, dynamic_id: '999' }, { ...reply, dynamic_id: Number(archive.id) },
      { ...reply, root_id: '999' }, { ...reply, root_id: Number(rootComment.id) },
      { ...reply, parent_id: '0' }, { ...reply, parent_id: 123 }, { ...reply, parent_id: undefined }, { ...reply, parent_id: reply.id },
      { ...reply, author: null }, { ...reply, author: { ...reply.author, id: 123 } },
      { ...reply, author: { ...reply.author, nickname: undefined } }, { ...reply, author: { ...reply.author, avatar_url: {} } },
      { ...reply, text: undefined }, { ...reply, text: {} }, { ...reply, published_at: 123 }, { ...reply, published_at: undefined },
      ...[-1, 1.5, '3', undefined, Number.MAX_SAFE_INTEGER + 1].map(value => ({ ...reply, like_count: value })),
      { ...reply, reply_to: undefined }, { ...reply, reply_to: [] }, { ...reply, reply_to: {} },
      { ...reply, reply_to: { ...reply.reply_to, id: 123 } }, { ...reply, reply_to: { ...reply.reply_to, nickname: 123 } },
      { ...reply, reply_to: { ...reply.reply_to, avatar_url: undefined } },
    ];
    for (const item of malformed) {
      const reader = createArchiveReader(async () => Response.json({ items: [{ ...reply, id: '888' }, item], next_cursor: null }));
      expect(await reader.readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit: 3, signal })).toEqual({ status: 'error' });
    }
    for (const limit of [3, 10]) {
      for (const body of [null, { items: {}, next_cursor: null }, { items: [reply, reply], next_cursor: null },
        { items: [], next_cursor: undefined }, { items: [], next_cursor: 1 },
        { items: Array.from({ length: limit + 1 }, (_, i) => ({ ...reply, id: String(100 + i) })), next_cursor: null }]) {
        const reader = createArchiveReader(async () => Response.json(body));
        expect(await reader.readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit, cursor: limit === 10 ? 'opaque' : null, signal }))
          .toEqual({ status: 'error' });
      }
    }
  });
  it('回复输入在 HTTP 前验证字符串父级与 cursor，并固定首3续10', async () => {
    const requests: string[] = [];
    const reader = createArchiveReader(async url => { requests.push(url); return Response.json({ items: [], next_cursor: null }); });
    const input = { dynamicId: archive.id, rootId: rootComment.id, limit: 3, signal };
    for (const id of ['../SECRET_TOKEN', '01', '0', '1'.repeat(129)]) {
      expect(await reader.readReplies({ ...input, dynamicId: id })).toEqual({ status: 'error' });
      expect(await reader.readReplies({ ...input, rootId: id })).toEqual({ status: 'error' });
    }
    // @ts-expect-error Verify runtime IDs are not coerced into strings.
    expect(await reader.readReplies({ ...input, rootId: 123 })).toEqual({ status: 'error' });
    // @ts-expect-error Verify runtime IDs are not coerced into strings.
    expect(await reader.readReplies({ ...input, dynamicId: 123 })).toEqual({ status: 'error' });
    // @ts-expect-error An opaque cursor must remain a string.
    expect(await reader.readReplies({ ...input, cursor: 123 })).toEqual({ status: 'error' });
    for (const limit of [0, 1, 2, 4, 10, 11, 3.5, NaN, Infinity]) {
      expect(await reader.readReplies({ ...input, limit })).toEqual({ status: 'error' });
    }
    for (const limit of [0, 3, 9, 11, 10.5]) {
      expect(await reader.readReplies({ ...input, limit, cursor: 'opaque' })).toEqual({ status: 'error' });
    }
    // @ts-expect-error Numeric strings are not valid batch sizes.
    expect(await reader.readReplies({ ...input, limit: '3' })).toEqual({ status: 'error' });
    expect(requests).toEqual([]);
  });
  it('根评论 DTO 映射保持大 ID、普通文本、来源回复数，不展示来源图片', async () => {
    const reader = createArchiveReader(async () => Response.json({ items: [rootComment], next_cursor: null }));
    expect(await reader.readComments({ dynamicId: archive.id, sort: 'hot', signal })).toEqual({ status: 'success', data: {
      items: [{ id: '900719925474099398765', author: { id: '123', nickname: '归档作者', avatarUrl: 'https://avatar.example.test/user.jpg' },
        publishedAt: '2026-03-01T12:03:04+08:00', text: '<script>not executable</script>\n评论 😀 https://example.test',
        likeCount: 0, replyCount: 25, pendingMediaCount: 1 }], nextCursor: null,
    } });
  });
  it('未知评论作者不伪造 UP，nullable 文本/时间/计数不伪造零或来源内容', async () => {
    const reader = createArchiveReader(async () => Response.json({ items: [{ ...rootComment,
      author: { id: null, nickname: null, avatar_url: null }, text: null, published_at: null,
      like_count: null, source_reply_count: null,
    }], next_cursor: null }));
    expect(await reader.readComments({ dynamicId: archive.id, sort: 'latest', signal })).toEqual({ status: 'success', data: {
      items: [{ id: '900719925474099398765', author: { id: '', nickname: null, avatarUrl: null },
        text: '', publishedAt: null, likeCount: null, replyCount: null, pendingMediaCount: 1 }], nextCursor: null,
    } });
  });
  it('最热/最新每批固定 20，45 条按服务端 20/20/5 原顺序读取，cursor 不透明编码', async () => {
    const pages = [
      Array.from({ length: 20 }, (_, i) => ({ ...rootComment, id: String(120 - i), like_count: i })),
      Array.from({ length: 20 }, (_, i) => ({ ...rootComment, id: String(100 - i), like_count: i })),
      Array.from({ length: 5 }, (_, i) => ({ ...rootComment, id: String(80 - i), like_count: i })),
    ];
    for (const sort of ['hot', 'latest'] as const) {
      const requests: string[] = [];
      const reader = createArchiveReader(async (url, init) => {
        expect(init).toEqual({ method: 'GET', signal });
        requests.push(url);
        const index = requests.length - 1;
        return Response.json({ items: pages[index], next_cursor: ['opaque+/=', 'second?&=', null][index] });
      });
      const first = await reader.readComments({ dynamicId: archive.id, sort, signal });
      const second = await reader.readComments({ dynamicId: archive.id, sort, cursor: 'opaque+/=', signal });
      const last = await reader.readComments({ dynamicId: archive.id, sort, cursor: 'second?&=', signal });
      expect([first, second, last].map(result => result.status === 'success' ? result.data.items.length : -1)).toEqual([20, 20, 5]);
      expect(first).toMatchObject({ status: 'success', data: { nextCursor: 'opaque+/=' } });
      if (first.status === 'success') expect(first.data.items.slice(0, 2)).toMatchObject([{ id: '120', likeCount: 0 }, { id: '119', likeCount: 1 }]);
      expect(last).toMatchObject({ status: 'success', data: { items: [{ id: '80' }, { id: '79' }, { id: '78' }, { id: '77' }, { id: '76' }], nextCursor: null } });
      expect(requests).toEqual([
        `/api/archive/dynamics/900719925474099312345/comments?sort=${sort}&limit=20`,
        `/api/archive/dynamics/900719925474099312345/comments?sort=${sort}&limit=20&cursor=opaque%2B%2F%3D`,
        `/api/archive/dynamics/900719925474099312345/comments?sort=${sort}&limit=20&cursor=second%3F%26%3D`,
      ]);
    }
  });
  it('只有匹配 HTTP 的 CURSOR_INVALID 映射 invalid-cursor，不自动重读或泄露错误', async () => {
    for (const [status, code, reason] of [
      [422, 'CURSOR_INVALID', 'invalid-cursor'], [422, 'INVALID_INPUT', undefined],
      [503, 'CURSOR_INVALID', undefined], [404, 'NOT_FOUND', undefined],
    ] as const) {
      const requests: string[] = [];
      const reader = createArchiveReader(async url => {
        requests.push(url); return Response.json({ error: { code, message: 'SECRET_TOKEN' } }, { status });
      });
      expect(await reader.readComments({ dynamicId: archive.id, sort: 'hot', cursor: 'broken+/=', signal }))
        .toEqual(reason ? { status: 'error', reason } : { status: 'error' });
      expect(requests).toEqual(['/api/archive/dynamics/900719925474099312345/comments?sort=hot&limit=20&cursor=broken%2B%2F%3D']);
    }
  });
  it('根评论坏 DTO 原子拒绝，不把串父级、回复或缺字段当作合法根评论', async () => {
    const malformed = [null, {}, { ...rootComment, id: 123 }, { ...rootComment, id: '01' },
      { ...rootComment, dynamic_id: '999' }, { ...rootComment, root_id: '1' }, { ...rootComment, parent_id: '1' },
      { ...rootComment, author: null }, { ...rootComment, author: { ...rootComment.author, id: 123 } },
      { ...rootComment, author: { ...rootComment.author, nickname: 123 } },
      { ...rootComment, author: { ...rootComment.author, avatar_url: {} } },
      { ...rootComment, text: undefined }, { ...rootComment, text: {} },
      { ...rootComment, published_at: 123 }, { ...rootComment, published_at: undefined },
      ...[-1, 1.5, '3', undefined, Number.MAX_SAFE_INTEGER + 1].map(value => ({ ...rootComment, like_count: value })),
      { ...rootComment, source_reply_count: '3' }, { ...rootComment, source_reply_count: undefined },
      { ...rootComment, comment_locator: [] }, { ...rootComment, comment_locator: undefined },
      { ...rootComment, media_sources: undefined }, { ...rootComment, media_sources: null },
      { ...rootComment, media_sources: [null] }, { ...rootComment, media_sources: [{ url: 123, width: null, height: null }] },
      { ...rootComment, media_sources: [{ url: 'https://example.test/p.jpg', width: '800', height: null }] },
    ];
    for (const item of malformed) {
      const reader = createArchiveReader(async () => Response.json({ items: [{ ...rootComment, id: '999' }, item], next_cursor: null }));
      expect(await reader.readComments({ dynamicId: archive.id, sort: 'hot', signal })).toEqual({ status: 'error' });
    }
    for (const body of [null, { items: {}, next_cursor: null }, { items: [rootComment, rootComment], next_cursor: null },
      { items: [], next_cursor: undefined }, { items: [], next_cursor: 1 },
      { items: Array.from({ length: 21 }, (_, i) => ({ ...rootComment, id: String(100 + i) })), next_cursor: null }]) {
      expect(await createArchiveReader(async () => Response.json(body)).readComments({ dynamicId: archive.id, sort: 'latest', signal }))
        .toEqual({ status: 'error' });
    }
  });
  it('非法父 ID 不进入 HTTP 路径，非法排序和 cursor 类型不被自动转字符串', async () => {
    const requests: string[] = [];
    const reader = createArchiveReader(async url => { requests.push(url); return Response.json({ items: [], next_cursor: null }); });
    for (const dynamicId of ['../SECRET_TOKEN', '01', '0', '123?x=SECRET_TOKEN', '1'.repeat(129)]) {
      expect(await reader.readComments({ dynamicId, sort: 'hot', signal })).toEqual({ status: 'error' });
    }
    // @ts-expect-error Verify the HTTP boundary rejects a malformed runtime caller.
    expect(await reader.readComments({ dynamicId: archive.id, sort: 'SECRET_TOKEN', signal })).toEqual({ status: 'error' });
    // @ts-expect-error An opaque cursor must remain a string, not a coerced number.
    expect(await reader.readComments({ dynamicId: archive.id, sort: 'hot', cursor: 123, signal })).toEqual({ status: 'error' });
    expect(requests).toEqual([]);
  });
  it('正文受限不阻断本地根评论，根分项及本地根/回复数独立映射', async () => {
    const reader = createArchiveReader(async url => Response.json(url.includes('/comments?')
      ? { items: [rootComment], next_cursor: null }
      : { ...archive, content_state: 'restricted', last_attempt: 'restricted',
        local_comment_count: 45, local_reply_count: 0, root_comments_last_attempt: 'success',
        work: { ...archive.work, comments: 'success', replies: 'pending' } }));
    expect(await reader.readDetail({ id: archive.id, signal })).toMatchObject({ status: 'success', data: {
      commentCount: 501, archive: { contentState: 'restricted', localCommentCount: 45, localReplyCount: 0,
        rootCommentsLastAttempt: 'success', work: { comments: 'success' } },
    } });
    expect(await reader.readComments({ dynamicId: archive.id, sort: 'hot', signal })).toMatchObject({ status: 'success', data: {
      items: [{ id: '900719925474099398765' }], nextCursor: null,
    } });
  });
  it('纯图根评论只暴露图片待归档数，恶意头像/来源 URL 不成为可展示 URL', async () => {
    for (const avatar_url of ['javascript:SECRET_TOKEN', 'data:image/svg+xml,SECRET_TOKEN',
      'http://avatar.example.test/user.jpg', 'https://user:SECRET_TOKEN@avatar.example.test/user.jpg', '//avatar.example.test/user.jpg']) {
      const reader = createArchiveReader(async () => Response.json({ items: [{ ...rootComment, text: '',
        author: { ...rootComment.author, nickname: ' ', avatar_url },
        published_at: '2026-02-30T12:03:04+08:00',
        media_sources: [{ url: 'javascript:SECRET_TOKEN', width: null, height: null },
          { url: 'https://upstream.example.test/comment.jpg', width: 800, height: 600 }],
      }], next_cursor: null }));
      expect(await reader.readComments({ dynamicId: archive.id, sort: 'hot', signal })).toEqual({ status: 'success', data: {
        items: [{ id: '900719925474099398765', author: { id: '123', nickname: null, avatarUrl: null },
          text: '', publishedAt: null, likeCount: 0, replyCount: 25, pendingMediaCount: 2 }], nextCursor: null,
      } });
    }
  });
  it('普通根评论分页失败不推进或自动重启，调用方可用同一 cursor 重试', async () => {
    for (const fail of [async () => new Response('SECRET_TOKEN'),
      async () => Response.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 503 }),
      async () => { throw new Error('SECRET_TOKEN'); }]) {
      const requests: string[] = [];
      const reader = createArchiveReader(async url => {
        requests.push(url);
        return requests.length === 1 ? fail() : Response.json({ items: [rootComment], next_cursor: null });
      });
      expect(await reader.readComments({ dynamicId: archive.id, sort: 'latest', cursor: 'same+/=', signal })).toEqual({ status: 'error' });
      expect(await reader.readComments({ dynamicId: archive.id, sort: 'latest', cursor: 'same+/=', signal })).toMatchObject({ status: 'success', data: {
        items: [{ id: '900719925474099398765' }], nextCursor: null,
      } });
      expect(requests).toEqual([
        '/api/archive/dynamics/900719925474099312345/comments?sort=latest&limit=20&cursor=same%2B%2F%3D',
        '/api/archive/dynamics/900719925474099312345/comments?sort=latest&limit=20&cursor=same%2B%2F%3D',
      ]);
    }
  });
  it('根评论预先取消不发 HTTP，传输/JSON 解析忽略 signal 时取消仍优先', async () => {
    const cancelled = new AbortController(); cancelled.abort();
    const requests: string[] = [];
    const reader = createArchiveReader(async url => { requests.push(url); throw new Error('SECRET_TOKEN'); });
    expect(await reader.readComments({ dynamicId: archive.id, sort: 'hot', signal: cancelled.signal })).toEqual({ status: 'cancelled' });
    expect(await reader.readReplies({ dynamicId: archive.id, rootId: rootComment.id, limit: 3, signal: cancelled.signal })).toEqual({ status: 'cancelled' });
    expect(requests).toEqual([]);
    for (const response of [Response.json({ items: [rootComment], next_cursor: null }),
      Response.json({ error: { code: 'CURSOR_INVALID', message: 'SECRET_TOKEN' } }, { status: 422 }), new Response('SECRET_TOKEN')]) {
      const controller = new AbortController();
      const late = createArchiveReader(async () => { controller.abort(); return response; });
      expect(await late.readComments({ dynamicId: archive.id, sort: 'hot', signal: controller.signal })).toEqual({ status: 'cancelled' });
    }
    const controller = new AbortController();
    const throwing = createArchiveReader(async () => { controller.abort(); throw new Error('SECRET_TOKEN'); });
    expect(await throwing.readComments({ dynamicId: archive.id, sort: 'hot', signal: controller.signal })).toEqual({ status: 'cancelled' });
  });
  it('Archive 回复工作、整轮/回复尝试与 checkpoint 独立映射，旧冻结 DTO 仍可读', async () => {
    for (const replies of ['pending', 'success'] as const) {
      const dto = { ...archive, local_comment_count: 45, local_reply_count: 25,
        comments_last_attempt: 'failed', replies_last_attempt: 'success',
        synced_comment_count: 70, synced_reply_comment_count: null,
        work: { ...archive.work, comments: 'pending', replies } };
      const reader = createArchiveReader(async url => Response.json(url.includes('?') ? { items: [dto], next_cursor: null } : dto));
      const expected = { archive: { localCommentCount: 45, localReplyCount: 25,
        commentsLastAttempt: 'failed', repliesLastAttempt: 'success', syncedCommentCount: 70, syncedReplyCommentCount: null,
        work: { comments: 'pending', replies } } };
      expect(await reader.readDetail({ id: archive.id, signal })).toMatchObject({ status: 'success', data: expected });
      expect(await reader.readList({ scope: { kind: 'all' }, limit: 10, signal })).toMatchObject({ status: 'success', data: { items: [expected] } });
    }
    const oldReader = createArchiveReader(async url => Response.json(url.includes('?') ? { items: [archive], next_cursor: null } : archive));
    const oldDetail = await oldReader.readDetail({ id: archive.id, signal });
    expect(oldDetail.status).toBe('success');
    if (oldDetail.status === 'success') {
      expect(oldDetail.data.archive?.commentsLastAttempt).toBeUndefined();
      expect(oldDetail.data.archive?.repliesLastAttempt).toBeUndefined();
      expect(oldDetail.data.archive?.syncedCommentCount).toBeUndefined();
      expect(oldDetail.data.archive?.syncedReplyCommentCount).toBeUndefined();
      expect(oldDetail.data.archive?.work.replies).toBeUndefined();
    }
    expect(await oldReader.readList({ scope: { kind: 'all' }, limit: 10, signal })).toMatchObject({ status: 'success' });
    for (const patch of [{ work: { ...archive.work, replies: 'failed' } }, { work: { ...archive.work, replies: null } },
      { comments_last_attempt: 'SECRET_TOKEN' }, { replies_last_attempt: 123 },
      { synced_comment_count: -1 }, { synced_comment_count: '70' },
      { synced_reply_comment_count: 1.5 }, { synced_reply_comment_count: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(await createArchiveReader(async () => Response.json({ ...archive, ...patch })).readDetail({ id: archive.id, signal }))
        .toEqual({ status: 'error' });
    }
  });
  it('接受媒体/评论分项状态，但不要求它们永远 pending', async () => {
    const reader = createArchiveReader(async () => Response.json({ ...archive,
      work: { text: 'success', media: 'success', comments: 'failed' },
    }));
    expect(await reader.readDetail({ id: archive.id, signal })).toMatchObject({ status: 'success', data: {
      archive: { work: { text: 'success', media: 'success', comments: 'failed' } },
    } });
  });
  it('HTTP 来源图仅保存 metadata，不影响正文读取、不成为可展示归档图', async () => {
    const reader = createArchiveReader(async () => Response.json({ ...archive,
      media_sources: [{ url: 'http://upstream.example.test/image.jpg', width: null, height: null }] }));
    expect(await reader.readDetail({ id: archive.id, signal })).toMatchObject({ status: 'success', data: {
      text: archive.text, images: [], archive: { mediaSources: [{ url: 'http://upstream.example.test/image.jpg', width: null, height: null }] },
    } });
  });
  it('空归档、404、失败不同；坏 DTO/HTTP/异常只返回安全错误', async () => {
    expect(await createArchiveReader(async () => Response.json({ items: [], next_cursor: null })).readList({ scope: { kind: 'all' }, limit: 10, signal }))
      .toEqual({ status: 'success', data: { items: [], nextCursor: null } });
    expect(await createArchiveReader(async () => new Response('SECRET_TOKEN', { status: 404 })).readDetail({ id: archive.id, signal }))
      .toEqual({ status: 'not-found' });
    for (const body of [null, { ...archive, id: 123 }, { ...archive, id: '999' }, { ...archive, text: null },
      { ...archive, content_state: 'SECRET_TOKEN' }, { ...archive, work: { text: 'success', media: 'done', comments: 'pending' } }]) {
      expect(await createArchiveReader(async () => Response.json(body)).readDetail({ id: archive.id, signal })).toEqual({ status: 'error' });
    }
    for (const transport of [async () => new Response('SECRET_TOKEN'), async () => Response.json({ error: { message: 'SECRET_TOKEN' } }, { status: 500 }),
      async () => { throw new Error('SECRET_TOKEN'); }]) {
      const reader = createArchiveReader(transport);
      expect(await reader.readList({ scope: { kind: 'all' }, limit: 10, signal })).toEqual({ status: 'error' });
      expect(await reader.readDetail({ id: archive.id, signal })).toEqual({ status: 'error' });
    }
    for (const body of [{ items: [archive, archive], next_cursor: null }, { items: [archive], next_cursor: 1 }, { items: 'SECRET_TOKEN', next_cursor: null }]) {
      expect(await createArchiveReader(async () => Response.json(body)).readList({ scope: { kind: 'all' }, limit: 10, signal })).toEqual({ status: 'error' });
    }
  });
  it('取消优先于忽略 signal 的成功、失败及异常，预先取消不发请求', async () => {
    for (const response of [Response.json({ items: [archive], next_cursor: null }), new Response('SECRET_TOKEN', { status: 502 })]) {
      const controller = new AbortController();
      const reader = createArchiveReader(async () => { controller.abort(); return response; });
      expect(await reader.readList({ scope: { kind: 'all' }, limit: 10, signal: controller.signal })).toEqual({ status: 'cancelled' });
    }
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    const reader = createArchiveReader(async () => { calls++; throw new Error('SECRET_TOKEN'); });
    expect(await reader.readDetail({ id: archive.id, signal: controller.signal })).toEqual({ status: 'cancelled' });
    expect(await reader.readList({ scope: { kind: 'all' }, limit: 10, signal: controller.signal })).toEqual({ status: 'cancelled' });
    expect(calls).toBe(0);
  });
  it('拒绝超出请求批量的列表，避免 API 异常把完整集合当单页展示', async () => {
    const reader = createArchiveReader(async () => Response.json({ items: Array.from({ length: 11 }, (_, i) => ({ ...archive, id: String(100 + i) })), next_cursor: null }));
    expect(await reader.readList({ scope: { kind: 'all' }, limit: 10, signal })).toEqual({ status: 'error' });
  });
  it('缺失身份、非法计数/日历时间安全兜底，不从编辑时间补发布时间', async () => {
    const reader = createArchiveReader(async () => Response.json({ ...archive,
      author: { id: '123', nickname: ' ', avatar_url: 'javascript:SECRET_TOKEN' },
      published_at: '2026-02-30T10:03:04+08:00', source_comment_count: -1,
    }));
    expect(await reader.readDetail({ id: archive.id, signal })).toMatchObject({ status: 'success', data: {
      publishedAt: null, commentCount: null, author: { nickname: null, avatarUrl: null },
      archive: { editedAt: '2026-03-02T13:01+08:00' },
    } });
  });
  it('生产根评论和回复均可读，成功空不冒充未归档', async () => {
    const requests: string[] = [];
    const reader = createArchiveReader(async url => { requests.push(url); return Response.json({ items: [], next_cursor: null }); });
    expect(reader.discussions).toBeUndefined();
    expect(reader.replies).toBeUndefined();
    expect(await reader.readComments({ dynamicId: archive.id, sort: 'hot', signal })).toEqual({ status: 'success', data: { items: [], nextCursor: null } });
    expect(await reader.readReplies({ dynamicId: archive.id, rootId: '1', limit: 3, signal })).toEqual({ status: 'success', data: { items: [], nextCursor: null } });
    expect(requests).toEqual(['/api/archive/dynamics/900719925474099312345/comments?sort=hot&limit=20',
      '/api/archive/dynamics/900719925474099312345/comments/1/replies?limit=3']);
  });
  it('只读归档 GET，原样传不透明 cursor 与字符串 ID，保留 metadata 但不展示来源业务图', async () => {
    const urls: string[] = [];
    const reader = createArchiveReader(async (url, init) => {
      urls.push(url); expect(init.method).toBe('GET'); expect(init.signal).toBe(signal);
      return Response.json(url.includes('/9007') ? archive : { items: [archive], next_cursor: 'opaque+/=' });
    });
    const first = await reader.readList({ scope: { kind: 'all' }, limit: 10, signal });
    expect(first).toMatchObject({ status: 'success', data: { nextCursor: 'opaque+/=', items: [{
      id: '900719925474099312345', author: { id: '123', nickname: '归档作者', avatarUrl: null },
      publishedAt: '2026-03-01T10:03:04+08:00', images: [], commentCount: 501,
      archive: { editedAt: '2026-03-02T13:01+08:00', editStatus: 'observed', contentState: 'success',
        lastAttempt: 'failed', localCommentCount: 0, mediaSources: [{ url: 'https://upstream.example.test/image.jpg', width: 800, height: 1200 }],
        commentLocator: { oid: '900719925474099312345', type: 17 }, observedVersion: 'v2', syncedVersion: 'v1',
        work: { text: 'pending', media: 'pending', comments: 'pending' } },
    }] } });
    await reader.readList({ scope: { kind: 'all' }, limit: 10, cursor: 'opaque+/=', signal });
    expect(await reader.readDetail({ id: archive.id, signal })).toMatchObject({ status: 'success', data: { text: archive.text } });
    expect(urls).toEqual(['/api/archive/dynamics?limit=10&scope=all', '/api/archive/dynamics?limit=10&scope=all&cursor=opaque%2B%2F%3D', `/api/archive/dynamics/${archive.id}`]);
    expect(reader.creator.nickname).not.toBe('模拟 UP');
  });
});

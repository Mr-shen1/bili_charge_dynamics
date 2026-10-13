import { describe, expect, it } from 'vitest';
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
describe('生产 ArchiveReader', () => {
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
  it('生产根评论解除全局未归档能力，回复仍未归档且不发 HTTP', async () => {
    const requests: string[] = [];
    const reader = createArchiveReader(async url => { requests.push(url); return Response.json({ items: [], next_cursor: null }); });
    expect(reader.discussions).toBeUndefined();
    expect(reader.replies).toBe('not-archived');
    expect(await reader.readComments({ dynamicId: archive.id, sort: 'hot', signal })).toEqual({ status: 'success', data: { items: [], nextCursor: null } });
    expect(await reader.readReplies({ dynamicId: archive.id, rootId: '1', limit: 3, signal })).toEqual({ status: 'error', reason: 'not-archived' });
    expect(requests).toEqual(['/api/archive/dynamics/900719925474099312345/comments?sort=hot&limit=20']);
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

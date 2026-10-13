import { describe, expect, it } from 'vitest';
import { createArchiveReader } from '../src/data/archiveReader';

import { archive } from './fixtures/archive';
const signal = new AbortController().signal;
describe('生产 ArchiveReader', () => {
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
  it('评论回复明确未归档，零本地数不是成功空讨论，且不请求不存在的 API', async () => {
    const reader = createArchiveReader(async () => { throw new Error('SECRET_TOKEN'); });
    expect(reader.discussions).toBe('not-archived');
    expect(await reader.readComments({ dynamicId: archive.id, sort: 'hot', signal })).toEqual({ status: 'error', reason: 'not-archived' });
    expect(await reader.readReplies({ dynamicId: archive.id, rootId: '1', limit: 3, signal })).toEqual({ status: 'error', reason: 'not-archived' });
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

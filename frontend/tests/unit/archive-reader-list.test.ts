import { describe, expect, it } from 'vitest';
import { createArchiveReader } from '../../src/data/archiveReader';
import { archive, archiveDynamic, archiveUser } from '../fixtures/archive';

const signal = new AbortController().signal;
const json = (body: unknown, status = 200) => Response.json(body, { status });

describe('生产 ArchiveReader：列表与 UP 身份', () => {
  it('按 scope 读取并原样传递不透明 cursor，不解析或推导分页', async () => {
    const urls: string[] = [];
    const reader = createArchiveReader(async (url, init) => {
      expect(init).toEqual({ method: 'GET', signal });
      urls.push(url);
      return json({ items: [archiveDynamic(2), archiveDynamic(1)], next_cursor: 'opaque+/=' });
    });
    expect(await reader.readList({ scope: { kind: 'all' }, limit: 10, signal })).toMatchObject({ status: 'success', data: {
      nextCursor: 'opaque+/=', items: [
        { id: '1002', text: '归档正文 2', author: { id: '123', nickname: '归档作者' } },
        { id: '1001', text: '归档正文 1' },
      ],
    } });
    expect(await reader.readList({ scope: { kind: 'up', upId: '123' }, limit: 10, cursor: 'opaque+/=', signal }))
      .toMatchObject({ status: 'success' });
    expect(urls).toEqual([
      '/api/archive/dynamics?limit=10&scope=all',
      '/api/archive/dynamics?limit=10&scope=up&uid=123&cursor=opaque%2B%2F%3D',
    ]);
  });

  it('区分未知 UP 与普通失败，单 UP 响应混入其他作者即拒绝', async () => {
    const unknown = createArchiveReader(async () => json({ error: { code: 'UNKNOWN_UP' } }, 404));
    expect(await unknown.readList({ scope: { kind: 'up', upId: '999' }, limit: 10, signal }))
      .toEqual({ status: 'error', reason: 'unknown-up' });

    const mismatched = createArchiveReader(async () => json({ items: [archiveDynamic(1)], next_cursor: null }));
    expect(await mismatched.readList({ scope: { kind: 'up', upId: '456' }, limit: 10, signal }))
      .toEqual({ status: 'error' });
  });

  it('cursor 失效单独映射，其他 422/404 仍是普通错误', async () => {
    const invalid = createArchiveReader(async () => json({ error: { code: 'INVALID_INPUT' } }, 422));
    expect(await invalid.readList({ scope: { kind: 'all' }, limit: 10, cursor: 'expired', signal }))
      .toEqual({ status: 'error', reason: 'invalid-cursor' });
    expect(await invalid.readList({ scope: { kind: 'all' }, limit: 10, signal }))
      .toEqual({ status: 'error' });
    expect(await createArchiveReader(async () => json({ error: { code: 'SECRET' } }, 500))
      .readList({ scope: { kind: 'all' }, limit: 10, signal })).toEqual({ status: 'error' });
  });

  it('拒绝超批量、重复 ID 与坏 DTO，不把异常响应当列表', async () => {
    const bodies = [
      { items: Array.from({ length: 11 }, (_value, index) => archiveDynamic(index)), next_cursor: null },
      { items: [archiveDynamic(1), archiveDynamic(1)], next_cursor: null },
      { items: [archiveDynamic(1)], next_cursor: 1 },
      { items: [{ ...archiveDynamic(1), text: null }], next_cursor: null },
      { items: [{ ...archiveDynamic(1), content_state: 'SECRET' }], next_cursor: null },
      { items: 'SECRET', next_cursor: null },
    ];
    for (const body of bodies) {
      expect(await createArchiveReader(async () => json(body)).readList({ scope: { kind: 'all' }, limit: 10, signal }))
        .toEqual({ status: 'error' });
    }
    for (const transport of [
      async () => new Response('SECRET_TOKEN', { status: 500 }),
      async () => { throw new Error('SECRET_TOKEN'); },
    ]) {
      expect(await createArchiveReader(transport).readList({ scope: { kind: 'all' }, limit: 10, signal }))
        .toEqual({ status: 'error' });
    }
  });

  it('取消优先于忽略 signal 的迟到成功或失败；预先取消不发请求', async () => {
    for (const response of [json({ items: [archiveDynamic(1)], next_cursor: null }), new Response('SECRET', { status: 502 })]) {
      const controller = new AbortController();
      const reader = createArchiveReader(async () => { controller.abort(); return response; });
      expect(await reader.readList({ scope: { kind: 'all' }, limit: 10, signal: controller.signal }))
        .toEqual({ status: 'cancelled' });
    }
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const reader = createArchiveReader(async () => { calls += 1; return json({}); });
    expect(await reader.readList({ scope: { kind: 'all' }, limit: 10, signal: controller.signal }))
      .toEqual({ status: 'cancelled' });
    expect(await reader.readUps({ signal: controller.signal })).toEqual({ status: 'cancelled' });
    expect(calls).toBe(0);
  });

  it('缺失时间、计数与身份安全兜底，来源图不冒充已归档图', async () => {
    const reader = createArchiveReader(async () => json({ items: [{
      ...archive,
      author: { id: '123', nickname: '   ', avatar_url: 'javascript:SECRET_TOKEN' },
      published_at: '2026-02-30T10:03:04+08:00',
      source_comment_count: -1,
      media: undefined,
    }], next_cursor: null }));
    const result = await reader.readList({ scope: { kind: 'all' }, limit: 10, signal });
    expect(result).toMatchObject({ status: 'success', data: { items: [{
      publishedAt: null, commentCount: null, images: [],
      author: { nickname: null, avatarUrl: null },
    }] } });
    expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
  });

  it('UP 身份列表保持服务端顺序，拒绝重复或非法 ID，失败不回显响应内容', async () => {
    const reader = createArchiveReader(async url => {
      expect(url).toBe('/api/archive/ups');
      return json({ ups: [archiveUser('7', '作者七'), archiveUser('8', ' ')] });
    });
    expect(await reader.readUps({ signal })).toEqual({ status: 'success', data: [
      { id: '7', nickname: '作者七', avatarUrl: null },
      { id: '8', nickname: null, avatarUrl: null },
    ] });

    for (const body of [
      { ups: [archiveUser('7', '作者七'), archiveUser('7', '重复')] },
      { ups: [archiveUser('abc', '非法')] },
      { ups: 'SECRET_TOKEN' },
    ]) {
      expect(await createArchiveReader(async () => json(body)).readUps({ signal })).toEqual({ status: 'error' });
    }
  });
});

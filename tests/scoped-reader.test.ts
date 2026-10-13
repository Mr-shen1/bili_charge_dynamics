import { describe, expect, it } from 'vitest';
import { createArchiveReader } from '../src/data/archiveReader';
import { createMockReader } from '../src/data/mockReader';
import { archive } from './fixtures/archive';

const signal = new AbortController().signal;
describe('显式 scope 的公开 Reader', () => {
  it('独立 mock 全部先排序，单 UP 独立分页，cursor 拒绝跨 scope/批量', async () => {
    const one = { id: '123', nickname: '一', avatarUrl: null };
    const two = { id: '456', nickname: '二', avatarUrl: null };
    const empty = { id: '789', nickname: null, avatarUrl: null };
    const reader = createMockReader({ creator: one, identities: [one, two, empty], dynamics:
      ['9', '2', '10', '1', '3', '4', '5', '6', '7', '8', '11', '12'].map((id, index) => ({
        id, author: index % 2 ? two : one, publishedAt: index < 10 ? '2026-01-01T00:00:00Z' : null, text: id, commentCount: 0,
      })),
    });
    expect(await reader.readUps({ signal })).toMatchObject({ status: 'success', data: [one, two, empty] });
    const all = await reader.readList({ scope: { kind: 'all' }, limit: 10, signal });
    if (all.status !== 'success') throw new Error('Expected success');
    expect(all.data.items.map(item => item.id)).toEqual(['1', '10', '2', '3', '4', '5', '6', '7', '8', '9']);
    const up = await reader.readList({ scope: { kind: 'up', upId: '123' }, limit: 3, signal });
    if (up.status !== 'success') throw new Error('Expected success');
    expect(up.data.items.map(item => item.id)).toEqual(['10', '3', '5']);
    expect(await reader.readList({ scope: { kind: 'up', upId: '123' }, limit: 3, signal, cursor: up.data.nextCursor }))
      .toMatchObject({ status: 'success', data: { items: [{ id: '7' }, { id: '9' }, { id: '11' }], nextCursor: null } });
    for (const input of [{ scope: { kind: 'all' } as const, limit: 3 }, { scope: { kind: 'up', upId: '456' } as const, limit: 3 },
      { scope: { kind: 'up', upId: '123' } as const, limit: 10 }]) {
      expect(await reader.readList({ ...input, cursor: up.data.nextCursor, signal })).toEqual({ status: 'error', reason: 'invalid-cursor' });
    }
    expect(await reader.readList({ scope: { kind: 'up', upId: '789' }, limit: 10, signal })).toEqual({ status: 'success', data: { items: [], nextCursor: null } });
    expect(await reader.readList({ scope: { kind: 'up', upId: '999' }, limit: 10, signal })).toEqual({ status: 'error', reason: 'unknown-up' });
  });
  it('mock 身份按 BINARY 字符串升序；非法 scope 输入不是未知合法 UP', async () => {
    const reader = createMockReader({ creator: { id: '2', nickname: null, avatarUrl: null }, identities: [
      { id: '900719925474099312345', nickname: null, avatarUrl: null }, { id: '10', nickname: null, avatarUrl: null },
    ], dynamics: [] });
    expect(await reader.readUps({ signal })).toEqual({ status: 'success', data: [
      { id: '10', nickname: null, avatarUrl: null }, { id: '2', nickname: null, avatarUrl: null },
      { id: '900719925474099312345', nickname: null, avatarUrl: null },
    ] });
    const production = createArchiveReader(async () => { throw new Error('Invalid input must not request HTTP'); });
    for (const adapter of [reader, production]) {
      expect(await adapter.readList({ scope: { kind: 'up', upId: '01' }, limit: 10, signal })).toEqual({ status: 'error' });
      expect(await adapter.readList({ scope: { kind: 'all' }, limit: 11, signal })).toEqual({ status: 'error' });
    }
  });
  it('未知 UP、失效 cursor、网络失败不混同，坏 scope 身份响应被拒绝', async () => {
    expect(await createArchiveReader(async () => Response.json({ error: { code: 'UNKNOWN_UP', message: 'SECRET' } }, { status: 404 }))
      .readList({ scope: { kind: 'up', upId: '999' }, limit: 10, signal })).toEqual({ status: 'error', reason: 'unknown-up' });
    expect(await createArchiveReader(async () => Response.json({ error: { code: 'INVALID_INPUT' } }, { status: 422 }))
      .readList({ scope: { kind: 'all' }, cursor: 'expired', limit: 10, signal })).toEqual({ status: 'error', reason: 'invalid-cursor' });
    expect(await createArchiveReader(async () => { throw new Error('SECRET'); })
      .readList({ scope: { kind: 'up', upId: '123' }, limit: 10, signal })).toEqual({ status: 'error' });
    expect(await createArchiveReader(async () => Response.json({ items: [archive], next_cursor: null }))
      .readList({ scope: { kind: 'up', upId: '456' }, limit: 10, signal })).toEqual({ status: 'error' });
    for (const ups of [[{ id: 123 }], [{ id: '123' }, { id: '123' }]]) {
      expect(await createArchiveReader(async () => Response.json({ ups })).readUps({ signal })).toEqual({ status: 'error' });
    }
  });
  it('生产传输隔离 scope，保留字符串 UID 和不透明 cursor，身份不依赖监控', async () => {
    const requests: string[] = [];
    const reader = createArchiveReader(async (url, init) => {
      requests.push(url);
      expect(init.method).toBe('GET');
      return Response.json(url.endsWith('/ups')
        ? { ups: [{ id: '123', nickname: '停止后的作者', avatar_url: null }] }
        : { items: [archive], next_cursor: null });
    });
    expect(await reader.readUps({ signal })).toEqual({ status: 'success', data: [{ id: '123', nickname: '停止后的作者', avatarUrl: null }] });
    expect(await reader.readList({ scope: { kind: 'up', upId: '123' }, limit: 10, cursor: 'opaque+/=', signal })).toMatchObject({ status: 'success' });
    await reader.readList({ scope: { kind: 'all' }, limit: 10, signal });
    expect(requests).toEqual(['/api/archive/ups', '/api/archive/dynamics?limit=10&scope=up&uid=123&cursor=opaque%2B%2F%3D', '/api/archive/dynamics?limit=10&scope=all']);
  });
});

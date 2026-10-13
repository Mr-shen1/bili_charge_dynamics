import { describe, expect, it } from 'vitest';
import { createMockReader } from '../src/data/mockReader';

const creator = { id: '90071992547409930', nickname: '纸飞机', avatarUrl: null };

describe('统一动态读取接口', () => {
  it('25 条动态按完整排序分为 10、10、5，重读同一标记不会跳批', async () => {
    const reader = createMockReader({ creator, dynamics: Array.from({ length: 25 }, (_, i) => ({
      id: String(i).padStart(2, '0'), author: creator, publishedAt: '2026-01-01T00:00:00Z',
      text: String(i), commentCount: 0,
    })).reverse() });
    const signal = new AbortController().signal;
    const first = await reader.readList({ scope: { kind: 'all' }, limit: 10, signal });
    if (first.status !== 'success') throw new Error('Expected success');
    const second = await reader.readList({ scope: { kind: 'all' }, limit: 10, signal, cursor: first.data.nextCursor });
    if (second.status !== 'success') throw new Error('Expected success');
    expect(second).toEqual(await reader.readList({ scope: { kind: 'all' }, limit: 10, signal, cursor: first.data.nextCursor }));
    const third = await reader.readList({ scope: { kind: 'all' }, limit: 10, signal, cursor: second.data.nextCursor });
    if (third.status !== 'success') throw new Error('Expected success');
    expect([first.data.items.length, second.data.items.length, third.data.items.length]).toEqual([10, 10, 5]);
    expect([...first.data.items, ...second.data.items, ...third.data.items].map(item => item.id)).toEqual([
      '00', '01', '02', '03', '04', '05', '06', '07', '08', '09',
      '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24',
    ]);
    expect(third.data.nextCursor).toBeNull();
    expect(await reader.readList({ scope: { kind: 'all' }, limit: 10, signal, cursor: 'comments:10' })).toEqual({ status: 'error', reason: 'invalid-cursor' });
    const anotherCreator = createMockReader({ creator: { ...creator, id: 'another' }, dynamics: [] });
    expect(await anotherCreator.readList({ scope: { kind: 'all' }, limit: 10, signal, cursor: first.data.nextCursor })).toEqual({ status: 'error', reason: 'invalid-cursor' });
  });
  it('缺失或无效时间/计数保留为空，零值保留；未知详情与取消读取语义不同', async () => {
    const reader = createMockReader({ creator, dynamics: [
      { id: 'missing', author: creator, publishedAt: null, text: '', commentCount: null },
      { id: 'bad-date', author: creator, publishedAt: '2026-02-30T00:00:00Z', text: '', commentCount: -1 },
      { id: 'ambiguous', author: creator, publishedAt: '2026-01-01T00:00:00', text: '', commentCount: 1.5 },
      { id: 'zero', author: creator, publishedAt: '2026-01-01T00:00:00+08:00', text: '', commentCount: 0 },
    ] });
    const signal = new AbortController().signal;
    const result = await reader.readList({ scope: { kind: 'all' }, limit: 10, signal });
    if (result.status !== 'success') throw new Error('Expected success');
    expect(result.data.items.map(item => [item.id, item.publishedAt, item.commentCount])).toEqual([
      ['zero', '2025-12-31T16:00:00.000Z', 0],
      ['ambiguous', null, null], ['bad-date', null, null], ['missing', null, null],
    ]);
    expect(result.data.nextCursor).toBeNull();
    expect(await reader.readDetail({ id: 'unknown', signal })).toEqual({ status: 'not-found' });
    const controller = new AbortController();
    controller.abort();
    expect(await reader.readDetail({ id: 'unknown', signal: controller.signal })).toEqual({ status: 'cancelled' });
    expect(await reader.readList({ scope: { kind: 'all' }, limit: 10, signal: controller.signal })).toEqual({ status: 'cancelled' });
  });
  it('对完整集合按明确时刻倒序读取最多十条，并以字符串 ID 打破并列', async () => {
    const reader = createMockReader({ creator, dynamics: [
      ...Array.from({ length: 11 }, (_, i) => ({
        id: `item-${String(i).padStart(2, '0')}`, author: creator,
        publishedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:01Z`,
        text: `正文 ${i}`, commentCount: 0,
      })),
      { id: '90071992547409931', author: creator, publishedAt: '2026-01-11T08:00:01+08:00', text: '并列', commentCount: 0 },
    ] });
    const result = await reader.readList({ scope: { kind: 'all' }, limit: 10, signal: new AbortController().signal });
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('Expected success');
    expect(result.data.items.map(item => item.id)).toEqual([
      '90071992547409931', 'item-10', 'item-09', 'item-08', 'item-07',
      'item-06', 'item-05', 'item-04', 'item-03', 'item-02',
    ]);
    expect(result.data.items[0]?.publishedAt).toBe('2026-01-11T00:00:01.000Z');
    expect(result.data.nextCursor).not.toBeNull();
  });
});

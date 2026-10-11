import { expect, it } from 'vitest';
import { createMockReader } from '../src/data/mockReader';
import { reader as normalReader } from '../src/data/assembly';

const creator = { id: 'up', nickname: '纸飞机', avatarUrl: null };
const dynamic = { id: 'd', author: creator, publishedAt: null, text: '', commentCount: 99 };
const comment = { author: creator, publishedAt: '2026-01-01T00:00:00Z', text: '评论', likeCount: 0, replyCount: 0 };

it('正常装配首条动态确有45条一级评论，两种排序各为20、20、5', async () => {
  const signal = new AbortController().signal;
  for (const sort of ['hot', 'latest'] as const) {
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const result = await normalReader.readComments({ dynamicId: '90071992547409931', sort, cursor, signal });
      if (result.status !== 'success') throw new Error('Expected success');
      sizes.push(result.data.items.length);
      cursor = result.data.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([20, 20, 5]);
  }
});

it('两种排序都在完整的45条集合上排序再按20、20、5分页，同标记重读及资源隔离', async () => {
  const reader = createMockReader({ creator, dynamics: [dynamic], comments: { d: Array.from({ length: 45 }, (_, i) => ({
    ...comment, id: String(i).padStart(2, '0'), likeCount: i,
  })).reverse() } });
  const signal = new AbortController().signal;
  for (const sort of ['hot', 'latest'] as const) {
    const first = await reader.readComments({ dynamicId: 'd', sort, signal });
    if (first.status !== 'success') throw new Error('Expected success');
    const second = await reader.readComments({ dynamicId: 'd', sort, signal, cursor: first.data.nextCursor });
    if (second.status !== 'success') throw new Error('Expected success');
    const third = await reader.readComments({ dynamicId: 'd', sort, signal, cursor: second.data.nextCursor });
    if (third.status !== 'success') throw new Error('Expected success');
    expect([first.data.items.length, second.data.items.length, third.data.items.length]).toEqual([20, 20, 5]);
    const ascending = [
      '00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14',
      '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29',
      '30', '31', '32', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44',
    ];
    expect([...first.data.items, ...second.data.items, ...third.data.items].map(item => item.id)).toEqual(sort === 'hot' ? [...ascending].reverse() : ascending);
    expect(third.data.nextCursor).toBeNull();
    expect(await reader.readComments({ dynamicId: 'd', sort, signal, cursor: first.data.nextCursor })).toEqual(second);
    expect(await reader.readComments({ dynamicId: 'other', sort, signal, cursor: first.data.nextCursor })).toEqual({ status: 'error' });
    expect(await reader.readComments({ dynamicId: 'd', sort: sort === 'hot' ? 'latest' : 'hot', signal, cursor: first.data.nextCursor })).toEqual({ status: 'error' });
  }
  expect(await reader.readComments({ dynamicId: 'd', sort: 'hot', signal, cursor: 'invalid' })).toEqual({ status: 'error' });
  const controller = new AbortController();
  controller.abort();
  expect(await reader.readComments({ dynamicId: 'd', sort: 'hot', signal: controller.signal })).toEqual({ status: 'cancelled' });
});

it('最热按完整集合点赞、时刻降序及字符串 ID 升序读取，缺失值置后且规范化', async () => {
  const reader = createMockReader({ creator, dynamics: [dynamic], comments: { d: [
    { ...comment, id: 'missing', likeCount: null, publishedAt: null },
    { ...comment, id: 'zero', publishedAt: '2026-01-03T00:00:00Z' },
    { ...comment, id: '90071992547409932', likeCount: 10 },
    { ...comment, id: '90071992547409931', likeCount: 10, publishedAt: '2026-01-01T08:00:00+08:00' },
    { ...comment, id: 'new', likeCount: 10, publishedAt: '2026-01-02T00:00:00Z' },
    { ...comment, id: 'invalid', likeCount: -1, publishedAt: '2026-02-30T00:00:00Z', author: { id: 'x', nickname: ' ', avatarUrl: ' ' } },
  ] } });
  const result = await reader.readComments({ dynamicId: 'd', sort: 'hot', signal: new AbortController().signal });
  if (result.status !== 'success') throw new Error('Expected success');
  expect(result.data.items.map(item => [item.id, item.likeCount, item.publishedAt])).toEqual([
    ['new', 10, '2026-01-02T00:00:00.000Z'],
    ['90071992547409931', 10, '2026-01-01T00:00:00.000Z'],
    ['90071992547409932', 10, '2026-01-01T00:00:00.000Z'],
    ['zero', 0, '2026-01-03T00:00:00.000Z'], ['invalid', null, null], ['missing', null, null],
  ]);
  expect(result.data.items[4]?.author).toEqual({ id: 'x', nickname: null, avatarUrl: null });
  const latest = await reader.readComments({ dynamicId: 'd', sort: 'latest', signal: new AbortController().signal });
  if (latest.status !== 'success') throw new Error('Expected success');
  expect(latest.data.items.map(item => item.id)).toEqual(['zero', 'new', '90071992547409931', '90071992547409932', 'invalid', 'missing']);
});

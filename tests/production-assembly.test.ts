import { expect, it, vi } from 'vitest';
import { reader } from '#assembly';

it('默认装配读取同源归档而非 mock 作者及数据', async () => {
  const fetchBoundary = vi.fn(async () => Response.json({ items: [], next_cursor: null }));
  vi.stubGlobal('fetch', fetchBoundary);
  try {
    expect(await reader.readList({ scope: { kind: 'all' }, limit: 10, signal: new AbortController().signal })).toEqual({
      status: 'success', data: { items: [], nextCursor: null },
    });
    expect(fetchBoundary).toHaveBeenCalledWith('/api/archive/dynamics?limit=10&scope=all', expect.objectContaining({ method: 'GET' }));
    expect(reader.creator).toEqual({ id: 'archive', nickname: '归档动态', avatarUrl: null });
  } finally { vi.unstubAllGlobals(); }
});

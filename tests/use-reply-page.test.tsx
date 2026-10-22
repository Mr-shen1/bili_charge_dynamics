import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ReadResult, ReplyBatch } from '../src/data/contracts';
import { useReplyPage } from '../src/dynamics/useReplyPage';

function batch(count: number): ReadResult<ReplyBatch> {
  return { status: 'success', data: { items: [], nextCursor: null, count } };
}
function deferred() {
  let resolve!: (value: ReadResult<ReplyBatch>) => void;
  const promise = new Promise<ReadResult<ReplyBatch>>(done => { resolve = done; });
  return { promise, resolve };
}

it('显式重复选择同页也重新请求，不缓存页响应', async () => {
  const read = vi.fn<(page: number, signal: AbortSignal) => Promise<ReadResult<ReplyBatch>>>()
    .mockResolvedValueOnce(batch(11)).mockResolvedValueOnce(batch(12));
  const { result } = renderHook(() => useReplyPage(read, null));
  expect(read).not.toHaveBeenCalled();
  await act(() => result.current.loadPage(2));
  expect(result.current.state.data?.count).toBe(11);
  await act(() => result.current.loadPage(2));
  expect(read.mock.calls.map(([page]) => page)).toEqual([2, 2]);
  expect(result.current.state.data?.count).toBe(12);
});

it('新页请求取消旧页，即使旧请求忽略取消也不能覆盖新结果', async () => {
  const old = deferred();
  const read = vi.fn<(page: number, signal: AbortSignal) => Promise<ReadResult<ReplyBatch>>>()
    .mockReturnValueOnce(old.promise).mockResolvedValueOnce(batch(30));
  const { result } = renderHook(() => useReplyPage(read, null));
  act(() => { void result.current.loadPage(1); });
  await act(() => result.current.loadPage(2));
  expect(read.mock.calls[0]![1].aborted).toBe(true);
  await act(async () => old.resolve(batch(100)));
  expect(result.current.state.page).toBe(2);
  expect(result.current.state.data?.count).toBe(30);
});

it('查询发现页数缩减时重新读取最新末页，不停留空白越界页', async () => {
  const read = vi.fn<(page: number, signal: AbortSignal) => Promise<ReadResult<ReplyBatch>>>()
    .mockResolvedValue(batch(11));
  const { result } = renderHook(() => useReplyPage(read, null));
  await act(() => result.current.loadPage(3));
  expect(read.mock.calls.map(([page]) => page)).toEqual([3, 2]);
  expect(result.current.state.page).toBe(2);
  expect(result.current.state.status).toBe('success');
});

it('翻页失败保留原页，显式重试仍查询失败的目标页', async () => {
  const read = vi.fn<(page: number, signal: AbortSignal) => Promise<ReadResult<ReplyBatch>>>()
    .mockResolvedValueOnce(batch(20)).mockResolvedValueOnce({ status: 'error' }).mockResolvedValueOnce(batch(21));
  const { result } = renderHook(() => useReplyPage(read, null));
  await act(() => result.current.loadPage(1));
  await act(() => result.current.loadPage(2));
  expect(result.current.state.page).toBe(1);
  expect(result.current.state.data?.count).toBe(20);
  expect(result.current.state.status).toBe('error');
  await act(() => result.current.retry());
  expect(read.mock.calls.map(([page]) => page)).toEqual([1, 2, 2]);
  expect(result.current.state.page).toBe(2);
});

it('卸载时取消在途请求，不重试、不轮询', async () => {
  const old = deferred();
  const read = vi.fn<(page: number, signal: AbortSignal) => Promise<ReadResult<ReplyBatch>>>()
    .mockReturnValue(old.promise);
  const { unmount } = renderHook(() => useReplyPage(read));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  unmount();
  expect(read.mock.calls[0]![1].aborted).toBe(true);
  await act(async () => old.resolve(batch(100)));
  expect(read).toHaveBeenCalledTimes(1);
});

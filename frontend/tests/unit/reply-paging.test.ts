import { expect, it } from 'vitest';
import { replyPageCount, replyPageEntries, replyPageSize } from '../../src/dynamics/replyPaging';

it('回复分页固定每页 10 条', () => {
  expect(replyPageSize).toBe(10);
});

it('末页只由本地回复总数决定，未知总数才退回当前条数', () => {
  // 25 条本地回复按 10/10/5 分为 3 页。
  expect(replyPageCount(25, 0)).toBe(3);
  expect(replyPageCount(20, 0)).toBe(2);
  expect(replyPageCount(21, 0)).toBe(3);
  // 零条与未知仍保留第 1 页，不产生 0 页。
  expect(replyPageCount(0, 0)).toBe(1);
  expect(replyPageCount(null, 4)).toBe(1);
  expect(replyPageCount(undefined, 14)).toBe(2);
  expect(replyPageCount(null, 0)).toBe(1);
});

it('宽屏页码保留当前页前后各两页与首尾页', () => {
  expect(replyPageEntries(1, 3)).toEqual([1, 2, 3]);
  expect(replyPageEntries(4, 6)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(replyPageEntries(1, 12)).toEqual([1, 2, 3, 4, 5, '…', 12]);
  expect(replyPageEntries(6, 12)).toEqual([1, '…', 4, 5, 6, 7, 8, '…', 12]);
  expect(replyPageEntries(12, 12)).toEqual([1, '…', 8, 9, 10, 11, 12]);
});

it('窄屏页码使用精简窗口', () => {
  expect(replyPageEntries(3, 4, true)).toEqual([1, 2, 3, 4]);
  expect(replyPageEntries(2, 12, true)).toEqual([1, 2, 3, '…', 12]);
  expect(replyPageEntries(6, 12, true)).toEqual([1, '…', 6, '…', 12]);
  expect(replyPageEntries(11, 12, true)).toEqual([1, '…', 10, 11, 12]);
});

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

it('页码保留当前页前后各两页与首尾页，宽窄屏同一口径', () => {
  expect(replyPageEntries(1, 3)).toEqual([1, 2, 3]);
  expect(replyPageEntries(4, 6)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(replyPageEntries(1, 12)).toEqual([1, 2, 3, 4, 5, '…', 12]);
  expect(replyPageEntries(6, 12)).toEqual([1, '…', 4, 5, 6, 7, 8, '…', 12]);
  expect(replyPageEntries(12, 12)).toEqual([1, '…', 8, 9, 10, 11, 12]);
  // 首尾都不省略：窗口贴边时不重复画出首/末页。
  expect(replyPageEntries(3, 12)).toEqual([1, 2, 3, 4, 5, '…', 12]);
  expect(replyPageEntries(10, 12)).toEqual([1, '…', 8, 9, 10, 11, 12]);
});

it('中段页码与首尾页一起出现：1 … 37 38 39 40 41 … 46', () => {
  expect(replyPageEntries(39, 46)).toEqual([1, '…', 37, 38, 39, 40, 41, '…', 46]);
  expect(replyPageEntries(20, 46)).toEqual([1, '…', 18, 19, 20, 21, 22, '…', 46]);
  expect(replyPageEntries(46, 46)).toEqual([1, '…', 42, 43, 44, 45, 46]);
});

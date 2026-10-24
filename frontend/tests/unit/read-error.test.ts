import { expect, it, vi } from 'vitest';
import { reportReadError } from '../../src/app/readError';

it('非生产装配记录读取异常原因，便于定位被折叠的编程错误', () => {
  const error = new Error('reply is not defined');
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    reportReadError('回复页码', error, true);
    expect(spy).toHaveBeenCalledWith('[read] 回复页码读取异常', error);
  } finally {
    spy.mockRestore();
  }
});

it('生产装配不输出读取异常，用户侧仍只看到统一的失败状态', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    reportReadError('回复页码', new Error('boom'), false);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
